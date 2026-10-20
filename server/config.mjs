/**
 * 配置读写：默认值、归一化、脱敏、原子保存。
 * 三个模型槽位：transcribe（转写）/ polish（润色）/ minutes（纪要）。
 */

import path from 'node:path';
import { readJson, writeJson, ensureDir } from './store.mjs';
import { AppError } from './errors.mjs';

export const MASK = '••••••••';
export const SLOT_KEYS = ['transcribe', 'polish', 'minutes'];
export const SLOT_LABELS = { transcribe: '转写模型', polish: '润色模型', minutes: '纪要模型' };

export const TRANSCRIBE_KINDS = ['openai-asr', 'dashscope-asr', 'gemini-audio', 'multimodal-chat', 'mock'];
export const CHAT_KINDS = ['openai-chat', 'gemini-chat', 'mock'];
export const ASR_ONLY_KINDS = ['openai-asr', 'dashscope-asr'];

export const KIND_LABELS = {
  'openai-asr': 'OpenAI 兼容 · 语音转写接口',
  'dashscope-asr': '阿里云百炼 · Paraformer 异步转写',
  'gemini-audio': 'Google Gemini · 音频理解',
  'multimodal-chat': 'OpenAI 兼容 · 多模态大模型',
  'openai-chat': 'OpenAI 兼容 · 对话补全',
  'gemini-chat': 'Google Gemini · 对话补全',
  mock: '内置模拟模型（试用，不消耗额度）',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '未配置';
}

export function defaultConfig() {
  return {
    version: 1,
    server: {
      port: 8787,
      maxConcurrent: 3,
      autoOpenBrowser: true,
    },
    models: {
      transcribe: {
        kind: 'openai-asr',
        isMultimodal: false,
        baseUrl: '',
        apiKey: '',
        model: '',
        language: '',
        languageHints: '',
        prompt: '',
        audioTransport: 'base64',
        dashscopeRegion: 'cn-beijing',
        maxOutputTokens: 0,
        timeoutSec: 900,
        maxRetries: 2,
      },
      polish: {
        kind: 'openai-chat',
        baseUrl: '',
        apiKey: '',
        model: '',
        temperature: 0.3,
        maxOutputTokens: 0,
        chunkChars: 6000,
        styleFormal: true,
        styleKeepTerms: true,
        styleRemoveFillers: true,
        systemPromptExtra: '',
        timeoutSec: 180,
        maxRetries: 2,
      },
      minutes: {
        kind: 'openai-chat',
        baseUrl: '',
        apiKey: '',
        model: '',
        temperature: 0.2,
        maxOutputTokens: 0,
        chunkChars: 6000,
        template: 'default',
        customPrompt: '',
        includeTimestamps: false,
        outputLanguage: 'zh',
        timeoutSec: 180,
        maxRetries: 2,
      },
    },
    workspaces: [],
    ui: { lastWorkspaceId: '' },
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

/** 只补 `/v1`，不猜测用户的具体路径；空字符串原样返回（界面会提示必填） */
export function normalizeBaseUrl(raw, protocol) {
  let url = normalizeString(raw);
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '') {
      if (protocol === 'openai') {
        parsed.pathname = '/v1';
      } else if (protocol === 'gemini') {
        parsed.pathname = '/v1beta';
      }
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new AppError(`接口地址格式不对：${raw}`, {
      code: 'INVALID_BASE_URL',
      hint: '示例：https://api.openai.com/v1 或 https://dashscope.aliyuncs.com',
    });
  }
}

function protocolOfKind(kind) {
  if (kind === 'gemini-audio' || kind === 'gemini-chat') return 'gemini';
  if (kind === 'dashscope-asr') return 'dashscope';
  return 'openai';
}

function normalizeTranscribe(raw = {}) {
  const kind = TRANSCRIBE_KINDS.includes(raw.kind) ? raw.kind : 'openai-asr';
  const asrOnly = ASR_ONLY_KINDS.includes(kind);
  return {
    kind,
    isMultimodal: asrOnly ? false : toBool(raw.isMultimodal, false),
    baseUrl: normalizeBaseUrl(raw.baseUrl, protocolOfKind(kind)),
    apiKey: normalizeString(raw.apiKey),
    model: normalizeString(raw.model),
    language: normalizeString(raw.language),
    languageHints: normalizeString(raw.languageHints),
    prompt: normalizeString(raw.prompt),
    audioTransport: raw.audioTransport === 'oss' ? 'oss' : 'base64',
    dashscopeRegion: normalizeString(raw.dashscopeRegion, 'cn-beijing') || 'cn-beijing',
    maxOutputTokens: clampInt(raw.maxOutputTokens, 0, 200000, 0),
    timeoutSec: clampInt(raw.timeoutSec, 30, 3600, 900),
    maxRetries: clampInt(raw.maxRetries, 0, 5, 2),
  };
}

function normalizePolish(raw = {}) {
  const kind = CHAT_KINDS.includes(raw.kind) ? raw.kind : 'openai-chat';
  return {
    kind,
    baseUrl: normalizeBaseUrl(raw.baseUrl, protocolOfKind(kind)),
    apiKey: normalizeString(raw.apiKey),
    model: normalizeString(raw.model),
    temperature: clampNumber(raw.temperature, 0, 2, 0.3),
    maxOutputTokens: clampInt(raw.maxOutputTokens, 0, 200000, 0),
    chunkChars: clampInt(raw.chunkChars, 500, 20000, 6000),
    styleFormal: toBool(raw.styleFormal, true),
    styleKeepTerms: toBool(raw.styleKeepTerms, true),
    styleRemoveFillers: toBool(raw.styleRemoveFillers, true),
    systemPromptExtra: normalizeString(raw.systemPromptExtra),
    timeoutSec: clampInt(raw.timeoutSec, 30, 3600, 180),
    maxRetries: clampInt(raw.maxRetries, 0, 5, 2),
  };
}

function normalizeMinutes(raw = {}) {
  const kind = CHAT_KINDS.includes(raw.kind) ? raw.kind : 'openai-chat';
  return {
    kind,
    baseUrl: normalizeBaseUrl(raw.baseUrl, protocolOfKind(kind)),
    apiKey: normalizeString(raw.apiKey),
    model: normalizeString(raw.model),
    temperature: clampNumber(raw.temperature, 0, 2, 0.2),
    maxOutputTokens: clampInt(raw.maxOutputTokens, 0, 200000, 0),
    chunkChars: clampInt(raw.chunkChars, 500, 20000, 6000),
    template: raw.template === 'custom' ? 'custom' : 'default',
    customPrompt: normalizeString(raw.customPrompt),
    includeTimestamps: toBool(raw.includeTimestamps, false),
    outputLanguage: normalizeString(raw.outputLanguage, 'zh') || 'zh',
    timeoutSec: clampInt(raw.timeoutSec, 30, 3600, 180),
    maxRetries: clampInt(raw.maxRetries, 0, 5, 2),
  };
}

function normalizeWorkspace(raw = {}) {
  const id = normalizeString(raw.id) || `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    name: normalizeString(raw.name) || '未命名工作区',
    path: normalizeString(raw.path),
    defaultDeliveryPath: normalizeString(raw.defaultDeliveryPath),
    createdAt: normalizeString(raw.createdAt) || new Date().toISOString(),
  };
}

export function normalizeConfig(raw = {}) {
  const base = defaultConfig();
  const models = raw.models || {};
  const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.map(normalizeWorkspace).filter((w) => w.path) : [];
  return {
    version: 1,
    server: {
      port: clampInt(raw.server?.port ?? base.server.port, 1, 65535, base.server.port),
      maxConcurrent: clampInt(raw.server?.maxConcurrent ?? base.server.maxConcurrent, 1, 5, 3),
      autoOpenBrowser: toBool(raw.server?.autoOpenBrowser, true),
    },
    models: {
      transcribe: normalizeTranscribe({ ...base.models.transcribe, ...(models.transcribe || {}) }),
      polish: normalizePolish({ ...base.models.polish, ...(models.polish || {}) }),
      minutes: normalizeMinutes({ ...base.models.minutes, ...(models.minutes || {}) }),
    },
    workspaces,
    ui: { lastWorkspaceId: normalizeString(raw.ui?.lastWorkspaceId) },
  };
}

/** 密钥脱敏：输出给前端时只给掩码 + 是否已配置 */
export function maskConfig(config) {
  const masked = structuredClone(config);
  for (const slot of SLOT_KEYS) {
    const cfg = masked.models[slot];
    const hasKey = Boolean(cfg.apiKey);
    cfg.apiKey = hasKey ? MASK : '';
    cfg.hasApiKey = hasKey;
  }
  return masked;
}

/** 槽位是否算“已配置” */
export function isSlotConfigured(slot, cfg) {
  if (!cfg) return false;
  if (cfg.kind === 'mock') return true;
  if (!cfg.kind) return false;
  return Boolean(cfg.baseUrl && cfg.model && cfg.apiKey);
}

/**
 * 把前端提交的局部配置合并到现有配置。
 * 密钥字段：传入 MASK / undefined → 保留原值；传入 null 或空字符串 → 清除。
 */
export function applyPatch(current, patch = {}) {
  const next = structuredClone(current);
  if (patch.server && typeof patch.server === 'object') {
    next.server = { ...next.server, ...patch.server };
  }
  if (patch.ui && typeof patch.ui === 'object') {
    next.ui = { ...next.ui, ...patch.ui };
  }
  if (Array.isArray(patch.workspaces)) {
    next.workspaces = patch.workspaces;
  }
  if (patch.models && typeof patch.models === 'object') {
    for (const slot of SLOT_KEYS) {
      const incoming = patch.models[slot];
      if (!incoming || typeof incoming !== 'object') continue;
      const target = { ...next.models[slot] };
      for (const [key, value] of Object.entries(incoming)) {
        if (key === 'hasApiKey') continue;
        if (key === 'apiKey') {
          if (value === undefined || value === MASK) continue;
          target.apiKey = value === null ? '' : normalizeString(value);
          continue;
        }
        target[key] = value;
      }
      next.models[slot] = target;
    }
  }
  return next;
}

export function configFilePath(dataDir) {
  return path.join(dataDir, 'config.json');
}

export async function createConfigStore({ dataDir, logger }) {
  await ensureDir(dataDir);
  const file = configFilePath(dataDir);
  let current = null;

  async function load() {
    const raw = await readJson(file, null);
    current = normalizeConfig(raw || {});
    if (!raw) await writeJson(file, current, { backup: false });
    return current;
  }

  function get() {
    if (!current) throw new AppError('配置尚未加载', { code: 'CONFIG_NOT_LOADED', status: 500 });
    return current;
  }

  async function save(next) {
    current = normalizeConfig(next);
    await writeJson(file, current, { backup: true });
    logger?.info?.('配置已保存');
    return current;
  }

  async function update(patch) {
    const merged = applyPatch(get(), patch);
    return save(merged);
  }

  await load();
  return { file, load, get, save, update, masked: () => maskConfig(get()) };
}
