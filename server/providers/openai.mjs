/** OpenAI 兼容协议：chat/completions、audio/transcriptions、多模态 input_audio。 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { AppError } from '../errors.mjs';
import { callFetch, getJson, joinUrl, openBlob, postForm, postJson, contentToText, mimeForPath } from './http.mjs';
import { parseTimestampedSegments, extOf } from '../lib/text.mjs';
import { uploadLocalFile } from './dashscope.mjs';

const AUDIO_INPUT_FORMATS = { '.mp3': 'mp3', '.wav': 'wav' };
const MAX_INLINE_BYTES = 15 * 1024 * 1024;
const MAX_WHISPER_BYTES = 25 * 1024 * 1024;

export function modelLabel(cfg) {
  return `${cfg.model || '未命名模型'} · OpenAI 兼容`;
}

function authHeaders(cfg) {
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

/** 润色/纪要用的对话补全 */
export async function chat(cfg, { system, user, signal, log } = {}) {
  const url = joinUrl(cfg.baseUrl, 'chat/completions');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const payload = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.3,
  };
  if (cfg.maxOutputTokens > 0) payload.max_tokens = cfg.maxOutputTokens;

  const res = await postJson(url, payload, {
    headers: authHeaders(cfg),
    timeoutMs: (cfg.timeoutSec || 180) * 1000,
    retries: cfg.maxRetries ?? 2,
    signal,
    provider: 'openai-chat',
    label: '对话补全',
  });

  const data = res.json || {};
  const message = data.choices?.[0]?.message;
  const text = contentToText(message?.content).trim();
  if (!text) {
    throw new AppError('模型返回了空内容', {
      code: 'EMPTY_COMPLETION',
      provider: 'openai-chat',
      hint: '模型可能触发了内容审核或输出上限，可尝试缩短分块大小',
      requestId: data.request_id || '',
    });
  }
  if (data.choices?.[0]?.finish_reason === 'length') {
    log?.warn?.('输出达到长度上限，内容可能被截断（可调小分块字数）');
  }
  return {
    text,
    usage: {
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    },
    label: modelLabel(cfg),
  };
}

function buildTranscriptionForm(cfg, blob, fileName, { verbose }) {
  const form = new FormData();
  form.append('model', cfg.model);
  if (cfg.language) form.append('language', cfg.language);
  if (cfg.prompt) form.append('prompt', cfg.prompt);
  if (verbose === 'segments') {
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
  } else if (verbose === 'verbose') {
    form.append('response_format', 'verbose_json');
  } else {
    form.append('response_format', 'json');
  }
  // 文件放最后一个字段：部分兼容服务（以及 OSS 表单）要求如此
  form.append('file', blob, fileName);
  return form;
}

/** 语音转写接口：优先拿逐段精确时间戳，不支持时自动降级。 */
export async function transcribe(cfg, { filePath, signal, log } = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) {
    throw new AppError(`找不到音频文件：${filePath}`, { code: 'FILE_NOT_FOUND', hint: '请确认工作区里的文件还在' });
  }
  if (stat.size > MAX_WHISPER_BYTES) {
    throw new AppError(`音频体积 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过该接口 25MB 上限`, {
      code: 'FILE_TOO_LARGE',
      hint: '安装 ffmpeg 后程序会自动切片，或改用百炼 Paraformer / Gemini 转写长音频',
    });
  }
  if (stat.size === 0) {
    throw new AppError('音频文件是空的', { code: 'EMPTY_FILE' });
  }

  const url = joinUrl(cfg.baseUrl, 'audio/transcriptions');
  const fileName = path.basename(filePath);
  const blob = await openBlob(filePath, mimeForPath(filePath));

  const modes = ['segments', 'verbose', 'plain'];
  let lastError = null;

  for (const mode of modes) {
    try {
      const form = buildTranscriptionForm(cfg, blob, fileName, { verbose: mode });
      const res = await postForm(url, form, {
        headers: authHeaders(cfg),
        timeoutMs: (cfg.timeoutSec || 900) * 1000,
        retries: cfg.maxRetries ?? 2,
        signal,
        provider: 'openai-asr',
        label: '语音转写',
      });
      const data = res.json || {};
      const segments = Array.isArray(data.segments)
        ? data.segments
            .map((s) => ({
              startMs: Math.round(Number(s.start) * 1000) || 0,
              endMs: s.end === undefined || s.end === null ? null : Math.round(Number(s.end) * 1000),
              text: String(s.text || '').trim(),
            }))
            .filter((s) => s.text)
        : [];
      const text = String(data.text || data.transcription || '').trim() || segments.map((s) => s.text).join('');
      if (!text) {
        throw new AppError('转写结果为空（音频里可能没有人声）', { code: 'EMPTY_TRANSCRIPT', provider: 'openai-asr' });
      }
      const quality = segments.length ? 'exact' : 'none';
      if (mode !== 'segments') log?.warn?.(`该接口不支持逐段返回，已降级为「${mode}」模式，时间戳不可用`);
      return {
        segments: segments.length ? segments : [{ startMs: 0, endMs: null, text }],
        text,
        quality,
        usage: { sttSeconds: data.duration ? Math.round(Number(data.duration)) : undefined },
        label: modelLabel(cfg),
      };
    } catch (err) {
      lastError = err;
      const retryableParam = err.status === 400 && /response_format|timestamp|granularit|verbose|language|prompt/i.test(err.message || '');
      if (!retryableParam) throw err;
      log?.warn?.(`接口拒绝 ${mode} 参数，尝试降级：${err.message}`);
    }
  }
  throw lastError || new AppError('转写失败', { code: 'TRANSCRIBE_FAILED', provider: 'openai-asr' });
}

function dashscopeRoot(cfg) {
  const region = String(cfg.dashscopeRegion || 'cn-beijing').toLowerCase();
  if (region.includes('intl') || region.includes('singapore') || region === 'ap-southeast-1') {
    return 'https://dashscope-intl.aliyuncs.com';
  }
  return 'https://dashscope.aliyuncs.com';
}

function audioContent(text, base64, format) {
  return [
    { type: 'input_audio', input_audio: { data: base64, format } },
    { type: 'text', text },
  ];
}

/** 多模态大模型直接把音频当输入 */
export async function transcribeMultimodal(cfg, { filePath, instruction, signal, log } = {}) {
  const ext = extOf(filePath);
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) throw new AppError(`找不到音频文件：${filePath}`, { code: 'FILE_NOT_FOUND' });

  const extra = cfg.prompt ? `\n\n补充要求：${cfg.prompt}` : '';
  const text = `${instruction}${extra}`;
  const transport = cfg.audioTransport === 'oss' ? 'oss' : 'base64';

  let payload;
  let headers = { ...authHeaders(cfg) };

  if (transport === 'oss') {
    log?.info?.('正在上传音频到百炼临时存储（供多模态模型读取）');
    const uploadCfg = { ...cfg, baseUrl: dashscopeRoot(cfg) };
    const ossUrl = await uploadLocalFile(uploadCfg, filePath, { signal, log });
    payload = {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: '你是专业的会议录音转写员，只输出逐行带时间戳的原文。' },
        {
          role: 'user',
          content: [
            { type: 'audio_url', audio_url: { url: ossUrl } },
            { type: 'text', text },
          ],
        },
      ],
    };
    headers = { ...headers, 'X-DashScope-OssResourceResolve': 'enable' };
  } else {
    const format = AUDIO_INPUT_FORMATS[ext];
    if (!format) {
      throw new AppError(`该方式只支持 mp3 / wav，当前文件是 ${ext || '未知格式'}`, {
        code: 'UNSUPPORTED_AUDIO_FORMAT',
        hint: '把音频转成 mp3，或改用百炼 Paraformer / Gemini 转写页',
      });
    }
    if (stat.size > MAX_INLINE_BYTES) {
      throw new AppError(`音频体积 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过内联 15MB 上限`, {
        code: 'FILE_TOO_LARGE',
        hint: '改用百炼临时存储（把“音频传输方式”设为 oss），或安装 ffmpeg 切片',
      });
    }
    const buffer = await fsp.readFile(filePath);
    payload = {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: '你是专业的会议录音转写员，只输出逐行带时间戳的原文。' },
        { role: 'user', content: audioContent(text, buffer.toString('base64'), format) },
      ],
    };
  }

  const url = joinUrl(cfg.baseUrl, 'chat/completions');
  let data;
  try {
    const res = await postJson(url, payload, {
      headers,
      timeoutMs: (cfg.timeoutSec || 900) * 1000,
      retries: cfg.maxRetries ?? 1,
      signal,
      provider: 'multimodal-chat',
      label: '多模态转写',
    });
    data = res.json || {};
  } catch (err) {
    if (err.status === 400 && transport === 'base64') {
      log?.warn?.(`内联音频被拒绝，重试一次 data URL 形式：${err.message}`);
      const buffer = await fsp.readFile(filePath);
      const format = AUDIO_INPUT_FORMATS[ext] || 'mp3';
      const content = [
        { type: 'input_audio', input_audio: { data: `data:audio/${format};base64,${buffer.toString('base64')}` } },
        { type: 'text', text },
      ];
      payload.messages[1].content = content;
      const res = await postJson(url, payload, {
        headers,
        timeoutMs: (cfg.timeoutSec || 900) * 1000,
        retries: 1,
        signal,
        provider: 'multimodal-chat',
        label: '多模态转写',
      });
      data = res.json || {};
    } else {
      throw err;
    }
  }

  const raw = contentToText(data.choices?.[0]?.message?.content).trim();
  if (!raw) {
    throw new AppError('多模态模型没有返回内容', {
      code: 'EMPTY_COMPLETION',
      provider: 'multimodal-chat',
      hint: '确认模型支持音频输入（如 qwen-omni、gpt-4o-audio 类）',
      requestId: data.request_id || '',
    });
  }
  const { segments } = parseTimestampedSegments(raw);
  if (!segments.length) {
    return {
      segments: [{ startMs: 0, endMs: null, text: raw }],
      text: raw,
      quality: 'none',
      label: modelLabel(cfg),
    };
  }
  return {
    segments,
    text: segments.map((s) => s.text).join('\n'),
    quality: 'estimated',
    label: modelLabel(cfg),
  };
}

/** 连接测试：GET /models（不支持时视为地址可达） */
export async function testConnection(cfg, { signal } = {}) {
  const started = Date.now();
  try {
    const res = await getJson(joinUrl(cfg.baseUrl, 'models'), {
      headers: authHeaders(cfg),
      timeoutMs: 20000,
      retries: 0,
      signal,
      provider: 'openai',
      label: '连接测试',
    });
    const models = Array.isArray(res.json?.data) ? res.json.data : [];
    const hit = models.some((m) => m.id === cfg.model);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: models.length
        ? `连接成功，账号可见 ${models.length} 个模型${hit ? `，包含 ${cfg.model}` : `，但列表里没有 ${cfg.model}（仍可能可用）`}`
        : '连接成功',
    };
  } catch (err) {
    if (err.status === 404) {
      return {
        ok: true,
        warning: true,
        latencyMs: Date.now() - started,
        message: '地址可访问，但该服务没有 /models 列表接口；真实转写需跑一次任务验证',
      };
    }
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: err.message,
      hint: err.hint,
      requestId: err.requestId,
    };
  }
}
