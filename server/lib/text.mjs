/** 文本处理：字幕解析、时间戳提取、分块、清洗。 */

import { parseTimestamp } from './time.mjs';

export const AUDIO_EXTS = [
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma', '.amr',
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.flv',
];

export const TEXT_EXTS = ['.txt', '.md', '.markdown', '.srt', '.vtt', '.text', '.log'];

export function extOf(filePath) {
  const name = String(filePath || '');
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot).toLowerCase();
}

export function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

export function normalizeNewlines(text) {
  return stripBom(text).replace(/\r\n?/g, '\n');
}

/** 字数：按非空白字符计（中文更贴近实际字数） */
export function charCount(text) {
  return String(text || '').replace(/\s/g, '').length;
}

/** 每 3 位加逗号 */
export function formatCount(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** SRT → [{startMs,endMs,text}] */
export function parseSrt(content) {
  const text = normalizeNewlines(content);
  const blocks = text.split(/\n{2,}/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex < 0) continue;
    const [fromRaw, toRaw] = lines[timeLineIndex].split('-->');
    const startMs = parseTimestamp(fromRaw);
    const endMs = parseTimestamp(toRaw);
    if (startMs === null) continue;
    const body = lines.slice(timeLineIndex + 1).join(' ').trim();
    if (!body) continue;
    segments.push({ startMs, endMs: endMs === null ? null : endMs, text: body });
  }
  return segments;
}

/** WebVTT → [{startMs,endMs,text}] */
export function parseVtt(content) {
  const text = normalizeNewlines(content).replace(/^WEBVTT.*$/m, '');
  return parseSrt(text.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2'));
}

export function looksLikeSubtitle(content) {
  return /-->/.test(String(content || '').slice(0, 4000));
}

export function parseSubtitle(content) {
  const text = normalizeNewlines(content);
  if (/^\s*WEBVTT/i.test(text)) return parseVtt(text);
  return parseSrt(text);
}

export function subtitleToPlainText(segments) {
  return segments.map((s) => s.text).join('\n');
}

/**
 * 从多模态模型输出里抽取「[起 - 止] 文本」段落。
 * 容错：`[00:13]`、`00:13 - 00:20`、「00:13」、`-`/`–`/`~`/`至` 等写法。
 * 返回 { segments, orphanLines }，quality 由调用方判断。
 */
export function parseTimestampedSegments(raw) {
  const lines = normalizeNewlines(raw).split('\n');
  const segments = [];
  const orphanLines = [];
  const tsPattern = /(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)/g;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const matches = [...line.matchAll(tsPattern)];
    if (!matches.length) {
      orphanLines.push(line);
      continue;
    }
    const startMs = parseTimestamp(matches[0][1]);
    let endMs = matches.length > 1 ? parseTimestamp(matches[1][1]) : null;
    if (startMs === null) {
      orphanLines.push(line);
      continue;
    }
    if (endMs !== null && endMs < startMs) endMs = null;
    const lastTs = matches[matches.length - 1];
    let body = line.slice(lastTs.index + lastTs[0].length);
    body = body.replace(/^[\s\][)）】>|,,、。，:：=-]+/, '').trim();
    // 去掉行首遗留的时间戳括号
    body = body.replace(/^[[(【<]+/, '').trim();
    if (!body) continue;
    if (segments.length && endMs === null) {
      // 只有开始时间的行：把结束时间留到下一段开始时再补
      segments.push({ startMs, endMs: null, text: body });
      continue;
    }
    segments.push({ startMs, endMs, text: body });
  }

  // 补全结束时间：用下一段开始时间，最后一段 +6 秒
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i].endMs === null) {
      const next = segments[i + 1];
      segments[i].endMs = next ? next.startMs : segments[i].startMs + 6000;
    }
  }

  // 无时间戳的行并入上一段；若在最前面，作为第 0 秒的一段
  if (orphanLines.length) {
    const joined = orphanLines.join(' ');
    if (segments.length) {
      segments[0] = { ...segments[0], text: `${joined} ${segments[0].text}`.trim() };
    } else {
      segments.push({ startMs: 0, endMs: null, text: joined });
    }
  }

  segments.sort((a, b) => a.startMs - b.startMs);
  return { segments, orphanLines };
}

/** 去掉每行开头的 `[00:00:05.3 - 00:00:11.8]` 时间戳 */
export function stripTimestampPrefixes(text) {
  return normalizeNewlines(text)
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*\[?\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*(?:-|–|~|至|到)\s*\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]?\s*/, '')
        .replace(/^\s*\[?\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]?\s*/, ''),
    )
    .join('\n')
    .trim();
}

/** 段落化：把连续的短行按空行/句末标点整理成自然段 */
export function tidyParagraphs(text) {
  const lines = normalizeNewlines(text).split('\n');
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) {
      blocks.push(current.join('').trim());
      current = [];
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(trimmed)) {
      flush();
      blocks.push(trimmed);
      continue;
    }
    current.push(trimmed);
    if (/[。！？!?；;：:]$/.test(trimmed)) flush();
  }
  flush();
  return blocks.filter(Boolean).join('\n\n');
}

/**
 * 按行分块：不超过 maxChars，块之间用最后若干行做 overlapChars 字的重叠。
 */
export function chunkText(text, { maxChars = 6000, overlapChars = 200 } = {}) {
  const normalized = normalizeNewlines(text).trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const lines = normalized.split('\n');
  const chunks = [];
  let current = [];
  let currentLen = 0;

  const pushCurrent = () => {
    if (!current.length) return;
    chunks.push(current.join('\n'));
    // 计算重叠尾巴
    const tail = [];
    let tailLen = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const line = current[i];
      if (!line.trim()) break;
      if (tailLen + line.length + 1 > overlapChars) break;
      tail.unshift(line);
      tailLen += line.length + 1;
    }
    current = tail;
    currentLen = tailLen;
  };

  for (const line of lines) {
    if (line.length > maxChars) {
      // 超长单行：先收尾，再硬切
      if (current.length) {
        chunks.push(current.join('\n'));
        current = [];
        currentLen = 0;
      }
      for (let i = 0; i < line.length; i += maxChars) {
        const piece = line.slice(i, i + maxChars);
        if (i + maxChars >= line.length) {
          current = [piece];
          currentLen = piece.length;
        } else {
          chunks.push(piece);
        }
      }
      continue;
    }
    const add = line.length + 1;
    if (currentLen + add > maxChars && currentLen > 0) pushCurrent();
    current.push(line);
    currentLen += add;
  }
  if (current.length) chunks.push(current.join('\n'));

  return chunks.map((c) => c.trim()).filter(Boolean);
}

/** 取一段文本的开头若干字，用于日志/预览 */
export function preview(text, max = 60) {
  const flat = normalizeNewlines(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
