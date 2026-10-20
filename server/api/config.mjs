/** 配置与系统信息接口。 */

import os from 'node:os';
import path from 'node:path';
import { json, readJsonBody } from '../http.mjs';
import { AppError } from '../errors.mjs';
import { MASK, kindLabel, normalizeConfig, SLOT_LABELS, SLOT_KEYS } from '../config.mjs';
import { slotStatus } from '../pipeline/resolve.mjs';
import { ffmpegStatus } from '../lib/ffmpeg.mjs';
import { nativeDialogInfo } from '../lib/native-dialog.mjs';
import * as openai from '../providers/openai.mjs';
import * as gemini from '../providers/gemini.mjs';
import * as dashscope from '../providers/dashscope.mjs';
import * as mock from '../providers/mock.mjs';

function buildTestConfig(configStore, slot, override) {
  const base = structuredClone(configStore.get());
  const stored = base.models[slot];
  const merged = { ...stored };
  for (const [key, value] of Object.entries(override || {})) {
    if (key === 'hasApiKey') continue;
    if (key === 'apiKey') {
      if (value === undefined || value === MASK || value === '') continue;
      merged.apiKey = String(value);
      continue;
    }
    merged[key] = value;
  }
  const normalized = normalizeConfig({ ...base, models: { ...base.models, [slot]: merged } });
  return normalized.models[slot];
}

function missingFields(cfg) {
  if (cfg.kind === 'mock') return [];
  const missing = [];
  if (!cfg.baseUrl) missing.push('接口地址');
  if (!cfg.model) missing.push('模型名');
  if (!cfg.apiKey) missing.push('API Key');
  return missing;
}

function testImpl(kind) {
  if (kind === 'mock') return mock.testConnection;
  if (kind === 'dashscope-asr') return dashscope.testConnection;
  if (kind === 'gemini-audio' || kind === 'gemini-chat') return gemini.testConnection;
  return openai.testConnection;
}

export function registerConfigRoutes(router, { configStore, logger, dataDir, runtime }) {
  const payload = () => {
    const config = configStore.get();
    return {
      config: configStore.masked(),
      slots: slotStatus(config),
      server: { port: runtime?.port || config.server.port },
    };
  };

  router.get('/api/config', async (req, res) => {
    json(res, 200, payload());
  });

  router.put('/api/config', async (req, res) => {
    const body = await readJsonBody(req);
    try {
      await configStore.update(body);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(`配置保存失败：${err.message}`, { code: 'CONFIG_SAVE_FAILED' });
    }
    logger.info('配置已更新');
    json(res, 200, payload());
  });

  router.post('/api/config/test', async (req, res) => {
    const body = await readJsonBody(req);
    const slot = String(body.slot || '');
    if (!SLOT_KEYS.includes(slot)) {
      throw new AppError('未知的模型槽位', { code: 'UNKNOWN_SLOT', hint: `可选：${SLOT_KEYS.join(' / ')}` });
    }
    const cfg = buildTestConfig(configStore, slot, body.config);
    const missing = missingFields(cfg);
    if (missing.length) {
      json(res, 200, {
        ok: false,
        message: `${SLOT_LABELS[slot]}还缺少：${missing.join('、')}`,
        hint: '补齐后再点一次「测试连接」',
      });
      return;
    }
    const started = Date.now();
    try {
      const result = await testImpl(cfg.kind)(cfg, {});
      logger.info(`连接测试 ${SLOT_LABELS[slot]}（${kindLabel(cfg.kind)}）：${result.ok ? '成功' : '失败'}`);
      json(res, 200, { ...result, slot, kind: cfg.kind, latencyMs: result.latencyMs ?? Date.now() - started });
    } catch (err) {
      const appError = err instanceof AppError ? err : new AppError(err.message || '测试失败', { code: 'TEST_FAILED' });
      json(res, 200, { ok: false, slot, kind: cfg.kind, message: appError.message, hint: appError.hint });
    }
  });

  router.get('/api/system/info', async (req, res) => {
    const config = configStore.get();
    json(res, 200, {
      appVersion: '1.0.0',
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      hostname: os.hostname(),
      dataDir,
      port: runtime?.port || config.server.port,
      configFile: path.join(dataDir, 'config.json'),
      ffmpeg: ffmpegStatus(),
      nativeDialog: nativeDialogInfo(),
      server: config.server,
      slotStatus: slotStatus(config),
    });
  });
}
