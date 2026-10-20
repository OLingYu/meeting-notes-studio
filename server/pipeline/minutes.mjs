/** 纪要步骤：长文本走「分段提要点 → 汇总成纪要」，短文本一次生成。 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.mjs';
import { chatComplete } from '../providers/chat.mjs';
import { chunkText, charCount, stripTimestampPrefixes } from '../lib/text.mjs';
import { segmentsToTimestampedText } from './artifacts.mjs';
import {
  minutesSystem,
  minutesNotesSystem,
  minutesNotesUser,
  minutesFinalUser,
} from './prompts.mjs';

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

/**
 * @param {object} args
 * @param {object} args.cfg 纪要模型配置
 * @param {string} args.inputText 干净的正文（润色结果 / 原文 / 用户文本）
 * @param {Array} [args.segments] 有时间戳的分段（用于 includeTimestamps）
 */
export async function runMinutes({
  cfg,
  inputText,
  segments,
  sourceLabel,
  signal,
  log,
  onProgress = () => {},
  cacheDir,
}) {
  const clean = String(inputText || '').trim();
  if (!clean) {
    throw new AppError('没有可生成纪要的文本', { code: 'EMPTY_INPUT' });
  }

  // 需要引用时间点时，用带时间戳的版本；否则用干净正文
  let workingText = clean;
  let segmentCount = 0;
  if (cfg.includeTimestamps && Array.isArray(segments) && segments.length) {
    workingText = segmentsToTimestampedText(segments);
    segmentCount = segments.length;
    log.info(`纪要将引用时间点（${segmentCount} 个时间段）`);
  } else if (segments?.length) {
    segmentCount = segments.length;
  }

  const chunks = chunkText(workingText, { maxChars: cfg.chunkChars || 6000, overlapChars: 0 });
  const system = minutesSystem(cfg);
  log.info(`纪要：输入 ${charCount(clean)} 字，分 ${chunks.length} 块`);

  let body;
  if (chunks.length <= 1) {
    const cachePath = path.join(cacheDir, 'minutes-final.md');
    const cached = await readCache(cachePath);
    if (cached) {
      log.info('纪要：命中缓存');
      body = cached;
    } else {
      log.info('纪要：单块直接生成');
      const result = await chatComplete(cfg, {
        system,
        user: minutesFinalUser({
          notes: null,
          sourceLabel,
          segmentCount,
        }) + `\n\n【会议记录开始】\n${workingText}\n【会议记录结束】`,
        signal,
        log,
      });
      body = result.text.trim();
      await writeCache(cachePath, body);
    }
    onProgress(1);
  } else {
    const notesSystem = minutesNotesSystem(cfg);
    const notesList = [];
    for (let i = 0; i < chunks.length; i += 1) {
      if (signal?.aborted) throw new AppError('任务已取消', { code: 'ABORTED', status: 499 });
      const cachePath = path.join(cacheDir, `notes-${String(i + 1).padStart(3, '0')}.md`);
      let notes = await readCache(cachePath);
      if (!notes) {
        log.info(`纪要：提取第 ${i + 1}/${chunks.length} 块要点…`);
        const result = await chatComplete(cfg, {
          system: notesSystem,
          user: minutesNotesUser({ text: chunks[i], index: i, total: chunks.length }),
          signal,
          log,
        });
        notes = result.text.trim();
        if (!notes) throw new AppError(`第 ${i + 1} 块要点为空`, { code: 'EMPTY_COMPLETION' });
        await writeCache(cachePath, notes);
      } else {
        log.info(`纪要：第 ${i + 1}/${chunks.length} 块要点命中缓存`);
      }
      notesList.push(notes);
      onProgress(0.15 + 0.6 * ((i + 1) / chunks.length));
    }

    const finalCache = path.join(cacheDir, 'minutes-final.md');
    const cachedFinal = await readCache(finalCache);
    if (cachedFinal) {
      log.info('纪要：汇总命中缓存');
      body = cachedFinal;
    } else {
      log.info('纪要：汇总所有要点…');
      const result = await chatComplete(cfg, {
        system,
        user: minutesFinalUser({
          notes: notesList.join('\n\n'),
          sourceLabel,
          segmentCount,
        }),
        signal,
        log,
      });
      body = result.text.trim();
      await writeCache(finalCache, body);
    }
    onProgress(1);
  }

  if (!body) throw new AppError('纪要生成结果为空', { code: 'EMPTY_COMPLETION', hint: '换一个模型或缩短分块字数再试' });
  body = stripTimestampPrefixes(body);
  log.info(`纪要完成：${charCount(body)} 字`);
  return { body, chunks: chunks.length };
}
