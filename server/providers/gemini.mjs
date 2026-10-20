/** Google Gemini 原生协议：generateContent（文本 / 内联音频）。 */

import fsp from 'node:fs/promises';
import { AppError } from '../errors.mjs';
import { getJson, joinUrl, postJson } from './http.mjs';
import { parseTimestampedSegments, extOf } from '../lib/text.mjs';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const MIME_BY_EXT = {
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

const MAX_INLINE_BYTES = 15 * 1024 * 1024;

export function modelLabel(cfg) {
  return `${cfg.model || '未命名模型'} · Gemini`;
}

function baseUrl(cfg) {
  const raw = String(cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  return raw || DEFAULT_BASE;
}

function headers(cfg) {
  return { 'x-goog-api-key': cfg.apiKey, 'Content-Type': 'application/json' };
}

function generationConfig(cfg) {
  const config = { temperature: cfg.temperature ?? 0.3 };
  if (cfg.maxOutputTokens > 0) config.max_output_tokens = cfg.maxOutputTokens;
  return config;
}

function extractText(data) {
  const feedback = data?.promptFeedback?.blockReason;
  if (feedback) {
    throw new AppError(`内容被安全策略拦截：${feedback}`, {
      code: 'BLOCKED',
      provider: 'gemini',
      hint: '把输入拆分得更小，或改用其他模型',
    });
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

export async function chat(cfg, { system, user, signal, log } = {}) {
  const url = `${baseUrl(cfg)}/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: generationConfig(cfg),
  };
  if (system) payload.system_instruction = { parts: [{ text: system }] };

  const res = await postJson(url, payload, {
    headers: headers(cfg),
    timeoutMs: (cfg.timeoutSec || 180) * 1000,
    retries: cfg.maxRetries ?? 2,
    signal,
    provider: 'gemini',
    label: 'Gemini 对话',
  });
  const text = extractText(res.json || {});
  if (!text) {
    throw new AppError('Gemini 返回了空内容', {
      code: 'EMPTY_COMPLETION',
      provider: 'gemini',
      hint: '模型可能被安全策略拦截，或输出被截断',
    });
  }
  if (res.json?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    log?.warn?.('输出达到长度上限，内容可能被截断（可调小分块字数）');
  }
  const usage = res.json?.usageMetadata || {};
  return {
    text,
    usage: { tokensIn: usage.promptTokenCount ?? 0, tokensOut: usage.candidatesTokenCount ?? 0 },
    label: modelLabel(cfg),
  };
}

/** 把整段音频作为内联数据交给 Gemini，要求它输出逐行时间戳 */
export async function transcribe(cfg, { filePath, instruction, signal, log } = {}) {
  const ext = extOf(filePath);
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new AppError(`Gemini 音频理解不支持 ${ext || '该'} 格式`, {
      code: 'UNSUPPORTED_AUDIO_FORMAT',
      hint: '请转成 mp3 / wav / m4a 后重试',
    });
  }
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) throw new AppError(`找不到音频文件：${filePath}`, { code: 'FILE_NOT_FOUND' });
  if (stat.size > MAX_INLINE_BYTES) {
    throw new AppError(`音频体积 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 Gemini 内联 15MB 上限`, {
      code: 'FILE_TOO_LARGE',
      hint: '安装 ffmpeg 让程序自动切片，或改用百炼 Paraformer 转写',
    });
  }

  const buffer = await fsp.readFile(filePath);
  const text = cfg.prompt ? `${instruction}\n\n补充要求：${cfg.prompt}` : instruction;
  const url = `${baseUrl(cfg)}/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: mime, data: buffer.toString('base64') } },
          { text },
        ],
      },
    ],
    generationConfig: { temperature: 0, max_output_tokens: cfg.maxOutputTokens > 0 ? cfg.maxOutputTokens : 65536 },
  };

  const res = await postJson(url, payload, {
    headers: headers(cfg),
    timeoutMs: (cfg.timeoutSec || 900) * 1000,
    retries: cfg.maxRetries ?? 1,
    signal,
    provider: 'gemini',
    label: 'Gemini 音频转写',
  });
  const raw = extractText(res.json || {});
  if (!raw) {
    throw new AppError('Gemini 没有返回转写内容', {
      code: 'EMPTY_TRANSCRIPT',
      provider: 'gemini',
      hint: '确认所选模型支持音频输入（如 gemini-2.5-flash）',
    });
  }
  const { segments } = parseTimestampedSegments(raw);
  const usage = res.json?.usageMetadata || {};
  if (!segments.length) {
    return {
      segments: [{ startMs: 0, endMs: null, text: raw }],
      text: raw,
      quality: 'none',
      usage: { tokensIn: usage.promptTokenCount ?? 0, tokensOut: usage.candidatesTokenCount ?? 0 },
      label: modelLabel(cfg),
    };
  }
  return {
    segments,
    text: segments.map((s) => s.text).join('\n'),
    quality: 'estimated',
    usage: { tokensIn: usage.promptTokenCount ?? 0, tokensOut: usage.candidatesTokenCount ?? 0 },
    label: modelLabel(cfg),
  };
}

export async function testConnection(cfg, { signal } = {}) {
  const started = Date.now();
  try {
    const res = await getJson(joinUrl(baseUrl(cfg), 'models'), {
      headers: { 'x-goog-api-key': cfg.apiKey },
      timeoutMs: 20000,
      retries: 0,
      signal,
      provider: 'gemini',
      label: '连接测试',
    });
    const models = Array.isArray(res.json?.models) ? res.json.models : [];
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `连接成功，可见 ${models.length} 个模型${models.some((m) => String(m.name || '').includes(cfg.model)) ? `，包含 ${cfg.model}` : ''}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: err.message,
      hint: err.hint,
      requestId: err.requestId,
    };
  }
}
