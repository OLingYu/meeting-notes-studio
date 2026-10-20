/** HTTP 基础设施：超时、退避重试、错误归一化成中文提示。 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.mjs';

const MIME_MAP = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  '.amr': 'audio/amr',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

export function mimeForPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

const HINTS = {
  400: '请求参数被拒绝：可能该模型不支持这个参数（例如 verbose_json、input_audio），请检查模型名与接口类型',
  401: '密钥无效：请检查 API Key 是否填对、是否带多余空格',
  403: '没有权限：请确认模型已开通、账号已实名或额度充足',
  404: '接口或模型不存在：请检查 Base URL（OpenAI 兼容一般以 /v1 结尾）与模型名',
  413: '上传内容过大：请改用支持大文件的转写方式，或让程序用 ffmpeg 切片',
  429: '触发限流或额度不足：稍后重试，或到服务商控制台确认余额',
  500: '模型服务端错误：稍后重试通常可恢复',
  502: '网关错误：请稍后重试，或检查 Base URL 是否指向了代理',
  503: '服务暂时不可用：请稍后重试',
  504: '网关超时：请稍后重试，或缩短单次输入',
};

function hintForStatus(status) {
  if (HINTS[status]) return HINTS[status];
  if (status >= 500) return HINTS[500];
  return '请检查接口地址、密钥与模型名是否正确';
}

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMessage(json, text) {
  const candidates = [
    json?.error?.message,
    json?.error?.msg,
    typeof json?.error === 'string' ? json.error : '',
    json?.message,
    json?.msg,
    json?.error_code ? `${json.error_code} ${json.error_msg || ''}` : '',
    json?.code && typeof json.code === 'string' && !/^\d+$/.test(json.code) ? json.code : '',
    text ? String(text).slice(0, 400) : '',
  ];
  for (const item of candidates) {
    if (item && String(item).trim()) return String(item).trim();
  }
  return '';
}

function extractRequestId(json, headers) {
  const fromHeaders = headers?.get?.('x-request-id') || headers?.get?.('x-dashscope-request-id') || '';
  return fromHeaders || json?.request_id || json?.requestId || json?.error?.request_id || '';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('任务已取消', { code: 'ABORTED', status: 499 }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(new AppError('任务已取消', { code: 'ABORTED', status: 499 }));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function abortedError() {
  return new AppError('任务已取消', { code: 'ABORTED', status: 499, hint: '这是你手动取消的操作' });
}

/**
 * 统一的 fetch 调用。
 * 返回 { status, headers, text, json }；失败抛 AppError。
 * 429/5xx/网络错误会自动重试（指数退避），4xx 直接失败。
 */
export async function callFetch(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 180000,
    retries = 2,
    signal,
    provider = '',
    label = '',
  } = options;

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortedError();
    const controller = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw abortedError();
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1000, timeoutMs));

    let failure = null;
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await response.text();
      const json = parseJsonSafe(text);
      if (response.ok) {
        return { status: response.status, headers: response.headers, text, json };
      }
      const status = response.status;
      const retryable = status === 429 || status >= 500;
      const retryAfterRaw = Number(response.headers.get('retry-after'));
      failure = {
        retryable,
        retryAfterMs: Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? Math.min(10000, retryAfterRaw * 1000) : undefined,
        error: new AppError(extractMessage(json, text) || `HTTP ${status}`, {
          code: `HTTP_${status}`,
          status,
          hint: hintForStatus(status),
          provider,
          requestId: extractRequestId(json, response.headers),
          detail: label ? `${label} ${method} ${url}` : `${method} ${url}`,
        }),
      };
    } catch (err) {
      if (signal?.aborted) throw abortedError();
      if (err instanceof AppError) {
        failure = { retryable: false, error: err };
      } else if (timedOut) {
        failure = {
          retryable: true,
          error: new AppError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`, {
            code: 'TIMEOUT',
            status: 504,
            hint: '网络较慢或模型响应过久；可以调大超时时间，或换更快的模型',
            provider,
            detail: `${method} ${url}`,
          }),
        };
      } else {
        const cause = err?.cause?.code || err?.cause?.message || err?.message || '未知网络错误';
        failure = {
          retryable: true,
          error: new AppError(`网络请求失败：${cause}`, {
            code: 'NETWORK',
            status: 502,
            hint: '请检查网络、代理或 Base URL 是否可访问',
            provider,
            detail: `${method} ${url}`,
          }),
        };
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onOuterAbort);
    }

    if (!failure) throw new AppError('未知错误', { code: 'UNKNOWN', status: 500 });
    if (!failure.retryable || attempt >= retries) throw failure.error;
    attempt += 1;
    const backoff = failure.retryAfterMs ?? Math.min(10000, 600 * 2 ** attempt + Math.random() * 300);
    await sleep(backoff, signal);
  }
}

export async function postJson(url, payload, options = {}) {
  return callFetch(url, {
    ...options,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: JSON.stringify(payload),
  });
}

export async function getJson(url, options = {}) {
  return callFetch(url, { ...options, method: 'GET' });
}

export async function postForm(url, form, options = {}) {
  return callFetch(url, { ...options, method: 'POST', body: form });
}

/** 本地文件 → Blob（大文件走流式 openAsBlob） */
export async function openBlob(filePath, mime) {
  const type = mime || mimeForPath(filePath);
  if (typeof fs.openAsBlob === 'function') {
    try {
      const blob = await fs.openAsBlob(filePath, { type });
      return blob;
    } catch { /* 回退到整读 */ }
  }
  const buffer = await fsp.readFile(filePath);
  return new Blob([buffer], { type });
}

export function joinUrl(base, suffix) {
  const left = String(base || '').replace(/\/+$/, '');
  const right = String(suffix || '').replace(/^\/+/, '');
  return `${left}/${right}`;
}

/** 从各种形状的 message.content 里取纯文本（OpenAI / 通义 兼容） */
export function contentToText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}
