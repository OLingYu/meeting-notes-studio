/** 三份 Markdown 产物的渲染、命名与落盘。 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { formatDateTime, formatDuration, formatRange, formatTimestamp, fileStamp } from '../lib/time.mjs';
import { formatCount } from '../lib/text.mjs';
import { heading, metaBlock, safeFileBase } from '../lib/md.mjs';

export const ARTIFACTS = {
  transcribe: { step: 'transcribe', title: '转写原文', suffix: '转写原文' },
  polish: { step: 'polish', title: '润色稿', suffix: '润色' },
  minutes: { step: 'minutes', title: '会议纪要', suffix: '纪要' },
};

const QUALITY_LABEL = {
  exact: '精确（转写接口返回的逐段起止时间）',
  estimated: '估算（模型按音频位置标注）',
  none: '不可用（该接口没有返回分段）',
};

function sourceLine({ sourceName, inputBytes, durationMs }) {
  const parts = [sourceName];
  if (inputBytes) parts.push(`${(inputBytes / 1024 / 1024).toFixed(2)} MB`);
  if (durationMs) parts.push(`时长约 ${formatDuration(durationMs)}`);
  return parts.join('，');
}

export function buildTranscriptMarkdown({
  sourceName,
  inputBytes,
  durationMs,
  modelLabel,
  quality,
  segments,
  createdAt = new Date(),
}) {
  const chars = segments.reduce((sum, s) => sum + String(s.text || '').length, 0);
  const lines = [
    heading(1, `转写原文：${sourceName}`),
    '',
    metaBlock([
      ['生成时间', formatDateTime(createdAt)],
      ['模型', modelLabel],
      ['时间戳', QUALITY_LABEL[quality] || quality],
      ['来源', sourceLine({ sourceName, inputBytes, durationMs })],
      ['分段数', `${segments.length} 段`],
      ['字数', formatCount(chars)],
    ]),
    '',
  ];

  if (quality === 'none') {
    lines.push(heading(2, '全文'), '');
    const text = segments.map((s) => s.text).filter(Boolean).join('\n\n');
    lines.push(text || '（没有识别到内容）', '');
  } else {
    lines.push(heading(2, '逐段原文'), '');
    for (const segment of segments) {
      const text = String(segment.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const speaker = segment.speakerId !== undefined && segment.speakerId !== null ? `说话人${Number(segment.speakerId) + 1}：` : '';
      lines.push(`${formatRange(segment.startMs, segment.endMs)} ${speaker}${text}`);
    }
    lines.push('');
  }

  lines.push('---', `> 由「会议纪要工坊」生成于 ${formatDateTime(createdAt)}`, '');
  return lines.join('\n');
}

export function buildPolishMarkdown({
  sourceName,
  modelLabel,
  body,
  basedOn,
  charCount,
  createdAt = new Date(),
}) {
  return [
    heading(1, `润色稿：${sourceName}`),
    '',
    metaBlock([
      ['生成时间', formatDateTime(createdAt)],
      ['模型', modelLabel],
      ['基于', basedOn],
      ['字数', formatCount(charCount || body.replace(/\s/g, '').length)],
    ]),
    '',
    heading(2, '正文'),
    '',
    body.trim(),
    '',
    '---',
    `> 已按要求保留原意与专有名词，仅做书面化整理。生成于 ${formatDateTime(createdAt)}`,
    '',
  ].join('\n');
}

export function buildMinutesMarkdown({
  sourceName,
  modelLabel,
  body,
  basedOn,
  createdAt = new Date(),
}) {
  return [
    heading(1, `会议纪要：${sourceName}`),
    '',
    metaBlock([
      ['生成时间', formatDateTime(createdAt)],
      ['模型', modelLabel],
      ['基于', basedOn],
      ['字数', formatCount(body.replace(/\s/g, '').length)],
    ]),
    '',
    body.trim(),
    '',
    '---',
    `> 由「会议纪要工坊」生成于 ${formatDateTime(createdAt)}`,
    '',
  ].join('\n');
}

/** 去掉扩展名，得到产物文件名主干 */
export function baseNameOf(filePath) {
  const base = path.basename(String(filePath || ''));
  const ext = path.extname(base);
  return base.slice(0, base.length - ext.length) || base || '未命名';
}

/** 生成不冲突的产物路径：`<主干>_<时间戳>_<后缀>.md`，重名时加 (2) */
export async function resolveArtifactPath({ deliveryDir, baseName, suffix, createdAt = new Date() }) {
  const safeBase = safeFileBase(baseName || '未命名', { maxLength: 60 });
  const stem = `${safeBase}_${fileStamp(createdAt)}_${suffix}`;
  let candidate = path.join(deliveryDir, `${stem}.md`);
  let index = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(deliveryDir, `${stem} (${index}).md`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

export async function writeArtifact(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${content.endsWith('\n') ? content : `${content}\n`}`, 'utf8');
  const stat = await fsp.stat(filePath);
  return { path: filePath, bytes: stat.size, chars: content.replace(/\s/g, '').length };
}

/** 把分段转成「[mm:ss] 文本」形式，供纪要提示词引用时间点 */
export function segmentsToTimestampedText(segments) {
  return segments
    .map((s) => `[${formatTimestamp(s.startMs).slice(0, 8)}] ${String(s.text || '').trim()}`)
    .filter(Boolean)
    .join('\n');
}
