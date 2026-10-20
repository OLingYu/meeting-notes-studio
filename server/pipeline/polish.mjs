/** 润色步骤：按字数分块，逐块润色，支持缓存续跑。 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.mjs';
import { chatComplete } from '../providers/chat.mjs';
import { chunkText, charCount, preview } from '../lib/text.mjs';
import { polishSystem, polishUser } from './prompts.mjs';

async function readCache(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function writeCache(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, text, 'utf8');
}

export async function runPolish({ cfg, inputText, signal, log, onProgress = () => {}, cacheDir }) {
  const text = String(inputText || '').trim();
  if (!text) {
    throw new AppError('没有可润色的文本', { code: 'EMPTY_INPUT', hint: '请确认上一步转写或你提供的文本里确实有内容' });
  }

  const chunks = chunkText(text, {
    maxChars: cfg.chunkChars || 6000,
    overlapChars: Math.min(300, Math.max(80, Math.round((cfg.chunkChars || 6000) * 0.03))),
  });
  log.info(`润色：共 ${chunks.length} 块，输入 ${charCount(text)} 字`);

  const system = polishSystem(cfg);
  const parts = [];
  for (let i = 0; i < chunks.length; i += 1) {
    if (signal?.aborted) throw new AppError('任务已取消', { code: 'ABORTED', status: 499 });
    const cachePath = path.join(cacheDir, `polish-${String(i + 1).padStart(3, '0')}.md`);
    let polished = await readCache(cachePath);
    if (polished) {
      log.info(`润色第 ${i + 1}/${chunks.length} 块：命中缓存`);
    } else {
      log.info(`润色第 ${i + 1}/${chunks.length} 块（${chunks[i].length} 字）…`);
      const prevTail = i > 0 ? preview(chunks[i - 1], 120) : '';
      const result = await chatComplete(cfg, {
        system,
        user: polishUser({ text: chunks[i], index: i, total: chunks.length, prevTail }),
        signal,
        log,
      });
      polished = result.text.trim();
      if (!polished) throw new AppError(`第 ${i + 1} 块润色结果为空`, { code: 'EMPTY_COMPLETION' });
      await writeCache(cachePath, polished);
    }
    parts.push(polished);
    onProgress((i + 1) / chunks.length);
  }

  const body = parts.join('\n\n').trim();
  log.info(`润色完成：输出 ${charCount(body)} 字`);
  return { text: body, chunks: chunks.length };
}
