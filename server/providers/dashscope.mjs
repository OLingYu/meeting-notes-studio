/**
 * 阿里云百炼（DashScope）：Paraformer 录音文件识别（异步 + OSS 临时上传）。
 * 流程：getPolicy → 表单上传到临时存储 → 提交异步任务 → 轮询 → 下载结果 JSON。
 * 注意：结果 URL 需要临时文件（本地路径）先上传，百炼不接受本地二进制流。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { AppError } from '../errors.mjs';
import { callFetch, getJson, openBlob, postForm, postJson } from './http.mjs';

export const DEFAULT_BASE = 'https://dashscope.aliyuncs.com';
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const POLL_INTERVAL_MS = 2000;

export function modelLabel(cfg) {
  return `${cfg.model || '未命名模型'} · 百炼`;
}

function baseUrl(cfg) {
  return String(cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '') || DEFAULT_BASE;
}

function auth(cfg) {
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

function sleepWithSignal(ms, signal) {
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

/** 步骤 1：获取文件上传凭证 */
export async function getUploadPolicy(cfg, { signal } = {}) {
  const url = `${baseUrl(cfg)}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(cfg.model)}`;
  const res = await getJson(url, {
    headers: { ...auth(cfg), 'Content-Type': 'application/json' },
    timeoutMs: 30000,
    retries: cfg.maxRetries ?? 2,
    signal,
    provider: 'dashscope',
    label: '获取上传凭证',
  });
  const data = res.json?.data;
  if (!data?.upload_host || !data?.upload_dir) {
    throw new AppError('百炼没有返回有效的上传凭证', {
      code: 'UPLOAD_POLICY_INVALID',
      provider: 'dashscope',
      requestId: res.json?.request_id || '',
      hint: '确认模型名正确（如 paraformer-v2），且账号已开通百炼',
    });
  }
  return data;
}

/** 步骤 2：把本地文件上传到百炼临时存储，返回 oss:// 临时 URL */
export async function uploadLocalFile(cfg, filePath, { signal, log } = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) throw new AppError(`找不到文件：${filePath}`, { code: 'FILE_NOT_FOUND' });
  if (stat.size === 0) throw new AppError('文件是空的', { code: 'EMPTY_FILE' });
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new AppError('文件超过 1GB，百炼临时上传不支持', { code: 'FILE_TOO_LARGE', hint: '请先切分音频' });
  }

  const policy = await getUploadPolicy(cfg, { signal });
  const maxMb = Number(policy.max_file_size_mb);
  if (Number.isFinite(maxMb) && maxMb > 0 && stat.size > maxMb * 1024 * 1024) {
    throw new AppError(`该模型单文件上限 ${maxMb}MB，当前文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB`, {
      code: 'FILE_TOO_LARGE',
      hint: '安装 ffmpeg 让程序自动切片，或换用支持更大文件的模型',
    });
  }

  const fileName = path.basename(filePath);
  const key = `${policy.upload_dir}/${fileName}`;
  const blob = await openBlob(filePath, 'application/octet-stream');
  const form = new FormData();
  form.append('OSSAccessKeyId', policy.oss_access_key_id);
  form.append('Signature', policy.signature);
  form.append('policy', policy.policy);
  form.append('x-oss-object-acl', policy.x_oss_object_acl);
  form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite);
  form.append('key', key);
  form.append('success_action_status', '200');
  // 表单里的 file 必须是最后一个字段
  form.append('file', blob, fileName);

  log?.info?.(`上传音频到百炼临时存储（${(stat.size / 1024 / 1024).toFixed(1)}MB）`);
  await postForm(policy.upload_host, form, {
    timeoutMs: Math.max(120000, Math.round((stat.size / 1024 / 1024) * 1000)),
    retries: 1,
    signal,
    provider: 'dashscope',
    label: '上传文件',
  });

  return `oss://${key}`;
}

function parseLanguageHints(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return text
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 步骤 3-5：提交、轮询、下载结果 */
export async function transcribe(cfg, { filePath, signal, log, onProgress } = {}) {
  const ossUrl = await uploadLocalFile(cfg, filePath, { signal, log });
  const base = baseUrl(cfg);
  const hints = parseLanguageHints(cfg.languageHints || cfg.language);

  const parameters = {
    channel_id: [0],
    timestamp_alignment_enabled: true,
  };
  if (hints.length) parameters.language_hints = hints;

  const submit = await postJson(`${base}/api/v1/services/audio/asr/transcription`, {
    model: cfg.model,
    input: { file_urls: [ossUrl] },
    parameters,
  }, {
    headers: {
      ...auth(cfg),
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    timeoutMs: 60000,
    retries: cfg.maxRetries ?? 2,
    signal,
    provider: 'dashscope',
    label: '提交转写任务',
  });

  const taskId = submit.json?.output?.task_id;
  if (!taskId) {
    throw new AppError('百炼没有返回任务 ID', {
      code: 'TASK_ID_MISSING',
      provider: 'dashscope',
      requestId: submit.json?.request_id || '',
    });
  }
  log?.info?.(`已提交百炼转写任务：${taskId}`);

  const startedAt = Date.now();
  const timeoutMs = (cfg.timeoutSec || 900) * 1000;
  let taskStatus = 'PENDING';
  let result = null;

  while (Date.now() - startedAt < timeoutMs) {
    await sleepWithSignal(POLL_INTERVAL_MS, signal);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const poll = await postJson(`${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, undefined, {
      headers: { ...auth(cfg), 'X-DashScope-Async': 'enable' },
      timeoutMs: 30000,
      retries: 1,
      signal,
      provider: 'dashscope',
      label: '查询任务状态',
    });
    taskStatus = poll.json?.output?.task_status || 'UNKNOWN';
    if (taskStatus === 'SUCCEEDED') {
      result = poll.json?.output;
      log?.info?.(`百炼任务完成（${elapsed}s）`);
      break;
    }
    if (taskStatus === 'FAILED' || taskStatus === 'CANCELED' || taskStatus === 'UNKNOWN') {
      const detail = poll.json?.output?.results?.[0];
      throw new AppError(`百炼转写任务失败（${taskStatus}）${detail?.message ? `：${detail.message}` : ''}`, {
        code: 'DASHSCOPE_TASK_FAILED',
        provider: 'dashscope',
        requestId: poll.json?.request_id || '',
        hint: '常见原因：音频格式不支持、时长超限、临时 URL 过期或文件下载失败',
      });
    }
    onProgress?.(Math.min(0.9, 0.2 + elapsed / (timeoutMs / 1000) * 0.6));
    if (elapsed % 30 < 3) log?.info?.(`百炼转写中… 已等待 ${elapsed}s（状态 ${taskStatus}）`);
  }

  if (!result) {
    throw new AppError(`等待百炼转写超时（${Math.round(timeoutMs / 1000)} 秒）`, {
      code: 'DASHSCOPE_TIMEOUT',
      provider: 'dashscope',
      hint: '长音频排队较久，可调大转写超时时间后重试',
    });
  }

  const subtask = result.results?.[0];
  if (!subtask || subtask.subtask_status !== 'SUCCEEDED') {
    throw new AppError(`转写子任务失败：${subtask?.code || '未知'} ${subtask?.message || ''}`.trim(), {
      code: 'DASHSCOPE_SUBTASK_FAILED',
      provider: 'dashscope',
    });
  }
  if (!subtask.transcription_url) {
    throw new AppError('转写成功但没有结果地址', { code: 'RESULT_URL_MISSING', provider: 'dashscope' });
  }

  const res = await callFetch(subtask.transcription_url, {
    timeoutMs: 120000,
    retries: 2,
    signal,
    provider: 'dashscope',
    label: '下载转写结果',
  });
  const data = res.json || {};
  const segments = [];
  for (const transcript of data.transcripts || []) {
    for (const sentence of transcript.sentences || []) {
      const text = String(sentence.text || '').trim();
      if (!text) continue;
      segments.push({
        startMs: Math.round(Number(sentence.begin_time) || 0),
        endMs: sentence.end_time === undefined || sentence.end_time === null ? null : Math.round(Number(sentence.end_time)),
        text,
        speakerId: sentence.speaker_id ?? undefined,
      });
    }
  }
  segments.sort((a, b) => a.startMs - b.startMs);
  if (!segments.length) {
    throw new AppError('百炼返回的转写结果为空（音频里可能没有人声）', {
      code: 'EMPTY_TRANSCRIPT',
      provider: 'dashscope',
      hint: '确认 language_hints 与音频语言匹配',
    });
  }

  const durationMs = Number(data.properties?.original_duration_in_milliseconds) || segments.at(-1)?.endMs || 0;
  return {
    segments,
    text: segments.map((s) => s.text).join('\n'),
    quality: 'exact',
    usage: { sttSeconds: durationMs ? Math.round(durationMs / 1000) : undefined },
    label: modelLabel(cfg),
    taskId,
  };
}

export async function testConnection(cfg, { signal } = {}) {
  const started = Date.now();
  try {
    const policy = await getUploadPolicy(cfg, { signal });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `连接成功，临时存储可用，单文件上限约 ${policy.max_file_size_mb || '未知'}MB`,
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
