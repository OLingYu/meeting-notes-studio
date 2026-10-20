/** 转写步骤：选适配器、必要时切片、合并时间戳。 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.mjs';
import * as openai from '../providers/openai.mjs';
import * as gemini from '../providers/gemini.mjs';
import * as dashscope from '../providers/dashscope.mjs';
import * as mock from '../providers/mock.mjs';
import { cleanupDir, detectFfmpeg, splitAudio } from '../lib/ffmpeg.mjs';
import { formatDuration, formatTimestamp } from '../lib/time.mjs';
import { transcribeInstruction } from './prompts.mjs';

const MB = 1024 * 1024;
const SINGLE_REQUEST_LIMIT = {
  'openai-asr': 24 * MB,
  'gemini-audio': 15 * MB,
  'multimodal-chat': 15 * MB,
  'dashscope-asr': 1024 * MB,
  mock: Number.POSITIVE_INFINITY,
};

const SPLIT_CHUNK_SECONDS = 600;

function offsetSegments(segments, offsetMs) {
  return segments.map((s) => ({
    ...s,
    startMs: Math.max(0, Math.round(Number(s.startMs) || 0) + offsetMs),
    endMs: s.endMs === null || s.endMs === undefined ? null : Math.max(0, Math.round(Number(s.endMs)) + offsetMs),
  }));
}

function mergeQuality(qualities) {
  if (qualities.every((q) => q === 'exact')) return 'exact';
  if (qualities.some((q) => q === 'estimated')) return 'estimated';
  return 'none';
}

async function callProvider(cfg, { filePath, signal, log, onProgress }) {
  switch (cfg.kind) {
    case 'openai-asr':
      return openai.transcribe(cfg, { filePath, signal, log });
    case 'dashscope-asr':
      return dashscope.transcribe(cfg, { filePath, signal, log, onProgress });
    case 'gemini-audio':
      return gemini.transcribe(cfg, {
        filePath,
        instruction: transcribeInstruction(cfg),
        signal,
        log,
      });
    case 'multimodal-chat':
      return openai.transcribeMultimodal(cfg, {
        filePath,
        instruction: transcribeInstruction(cfg),
        signal,
        log,
      });
    case 'mock':
      return mock.transcribe(cfg, { filePath, signal, log });
    default:
      throw new AppError(`不支持的转写模型类型：${cfg.kind}`, {
        code: 'UNSUPPORTED_KIND',
        hint: '请到「设置 → 转写模型」重新选择接口类型',
      });
  }
}

/**
 * 执行转写。
 * 返回 { segments, text, quality, label, durationMs, inputBytes, usage }
 */
export async function runTranscribe({ cfg, filePath, signal, log, onProgress = () => {}, tempDir }) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) {
    throw new AppError(`找不到音频文件：${filePath}`, {
      code: 'FILE_NOT_FOUND',
      hint: '请确认工作区里的文件没有被移动或删除',
    });
  }
  if (stat.size === 0) {
    throw new AppError('音频文件是空的', { code: 'EMPTY_FILE', hint: '换一个文件试试' });
  }

  let limit = SINGLE_REQUEST_LIMIT[cfg.kind] ?? 24 * MB;
  // 多模态走百炼临时存储时不受 15MB 内联限制
  if (cfg.kind === 'multimodal-chat' && cfg.audioTransport === 'oss') {
    limit = 1024 * MB;
  }
  let chunks = [{ filePath, offsetMs: 0 }];
  let splitDir = null;

  if (stat.size > limit) {
    if (!detectFfmpeg().available) {
      throw new AppError(
        `音频 ${(stat.size / MB).toFixed(1)}MB 超过当前接口的单次上限 ${Math.round(limit / MB)}MB，且没有找到 ffmpeg 无法自动切片`,
        {
          code: 'FILE_TOO_LARGE',
          hint: '安装 ffmpeg 并加入 PATH 后重试，或改用百炼 Paraformer（支持长音频），或换更小的音频文件',
        },
      );
    }
    log.info(`音频 ${(stat.size / MB).toFixed(1)}MB 超过单次上限，开始用 ffmpeg 切片`);
    splitDir = path.join(tempDir, `split-${Date.now()}`);
    chunks = await splitAudio(filePath, {
      chunkSeconds: SPLIT_CHUNK_SECONDS,
      outDir: splitDir,
      signal,
      log,
    });
    log.info(`已切分为 ${chunks.length} 个片段，逐段转写后会自动合并时间戳`);
  }

  const results = [];
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      if (signal?.aborted) throw new AppError('任务已取消', { code: 'ABORTED', status: 499 });
      const chunk = chunks[i];
      if (chunks.length > 1) log.info(`转写片段 ${i + 1}/${chunks.length}（起始 ${formatTimestamp(chunk.offsetMs)}）`);
      const res = await callProvider(cfg, {
        filePath: chunk.filePath,
        signal,
        log,
        onProgress: (fraction) => onProgress((i + Math.min(1, Math.max(0, fraction))) / chunks.length),
      });
      results.push({ res, offsetMs: chunk.offsetMs });
      onProgress((i + 1) / chunks.length);
    }
  } finally {
    if (splitDir) await cleanupDir(splitDir);
  }

  const segments = [];
  for (const { res, offsetMs } of results) {
    segments.push(...offsetSegments(res.segments || [], offsetMs));
  }
  segments.sort((a, b) => a.startMs - b.startMs);

  const text = results
    .map((r) => r.res.text)
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!segments.length && !text) {
    throw new AppError('转写结果为空（音频里可能没有人声）', {
      code: 'EMPTY_TRANSCRIPT',
      hint: '确认音频不是静音、格式可被模型解析',
    });
  }

  const endTimes = segments.map((s) => s.endMs).filter((v) => typeof v === 'number');
  const durationMs = endTimes.length ? Math.max(...endTimes) : null;
  const usage = results.reduce(
    (acc, r) => ({
      sttSeconds: (acc.sttSeconds || 0) + (r.res.usage?.sttSeconds || 0) || undefined,
      tokensIn: (acc.tokensIn || 0) + (r.res.usage?.tokensIn || 0) || undefined,
      tokensOut: (acc.tokensOut || 0) + (r.res.usage?.tokensOut || 0) || undefined,
    }),
    {},
  );

  log.info(`转写完成：${segments.length} 段，时长约 ${formatDuration(durationMs || 0)}`);
  return {
    segments,
    text,
    quality: mergeQuality(results.map((r) => r.res.quality || 'none')),
    label: results[0]?.res.label || cfg.model,
    durationMs,
    inputBytes: stat.size,
    usage,
    provider: cfg.kind,
  };
}
