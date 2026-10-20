/** 流程解析：勾选的步骤 → 输入类型 / 所需扩展名 / 模型解析（含多模态回退）。 */

import { isSlotConfigured, SLOT_LABELS, kindLabel } from '../config.mjs';
import { AUDIO_EXTS, TEXT_EXTS, extOf } from '../lib/text.mjs';
import { chatKindOf } from '../providers/chat.mjs';

export const STEPS = ['transcribe', 'polish', 'minutes'];
export const STEP_LABELS = { transcribe: '转写', polish: '润色', minutes: '纪要' };
export const STEP_DESCRIPTIONS = {
  transcribe: '把音频转成带时间段的原文',
  polish: '把口语转写稿润色成通顺书面稿',
  minutes: '生成结构化会议纪要',
};

/** 去掉非法项并按固定顺序排列 */
export function normalizeSteps(input) {
  if (!Array.isArray(input)) return [];
  const set = new Set(input.filter((s) => STEPS.includes(s)));
  return STEPS.filter((s) => set.has(s));
}

/** 勾了转写就必须给音频；否则用文本 */
export function inputKindFor(steps) {
  return steps.includes('transcribe') ? 'audio' : 'text';
}

export function acceptedExts(kind) {
  return kind === 'audio' ? AUDIO_EXTS : TEXT_EXTS;
}

export function validationForInput(kind, filePath) {
  const ext = extOf(filePath);
  const exts = acceptedExts(kind);
  if (!exts.includes(ext)) {
    return {
      ok: false,
      message: kind === 'audio'
        ? `这个流程需要音频文件，当前是「${ext || '无扩展名'}」，支持：${AUDIO_EXTS.join(' ')}`
        : `这个流程需要文本文件，当前是「${ext || '无扩展名'}」，支持：${TEXT_EXTS.join(' ')}`,
    };
  }
  return { ok: true };
}

function planEntry(slotKey, cfg, { fallback = false } = {}) {
  return {
    slot: slotKey,
    source: fallback ? 'transcribe' : slotKey,
    fallback,
    chatKind: chatKindOf(cfg.kind),
    kind: cfg.kind,
    model: cfg.model,
    label: kindLabel(cfg.kind),
    cfg,
  };
}

/**
 * 解析本次任务实际使用的模型。
 * 返回 { plan, missing, ready }；missing 里的 message 直接给界面用。
 */
export function resolveModels(config, steps) {
  const missing = [];
  const plan = { transcribe: null, polish: null, minutes: null };

  const transcribeCfg = config.models.transcribe;
  const transcribeReady = isSlotConfigured('transcribe', transcribeCfg);
  if (steps.includes('transcribe')) {
    if (transcribeReady) plan.transcribe = planEntry('transcribe', transcribeCfg);
    else {
      missing.push({
        slot: 'transcribe',
        slotLabel: SLOT_LABELS.transcribe,
        message: '还没有配置转写模型：请到「设置 → 转写模型」填写接口地址、密钥与模型名，或在转写页选用内置模拟模型试用',
      });
    }
  }

  const transcribeCanHostChat = transcribeReady && transcribeCfg.isMultimodal && chatKindOf(transcribeCfg.kind);

  for (const slot of ['polish', 'minutes']) {
    if (!steps.includes(slot)) continue;
    if (isSlotConfigured(slot, config.models[slot])) {
      plan[slot] = planEntry(slot, config.models[slot]);
      continue;
    }
    if (transcribeCanHostChat) {
      plan[slot] = planEntry(slot, transcribeCfg, { fallback: true });
      continue;
    }
    missing.push({
      slot,
      slotLabel: SLOT_LABELS[slot],
      message: `还没有配置${SLOT_LABELS[slot]}：请到「设置 → ${SLOT_LABELS[slot]}」填写，或在转写页把模型标记为「多模态（可兼任润色与纪要）」后由它统一处理`,
    });
  }

  return { plan, missing, ready: missing.length === 0 };
}

/** 槽位状态摘要（首页/设置页用） */
export function slotStatus(config) {
  const t = config.models.transcribe;
  const entries = [];
  for (const slot of STEPS) {
    const cfg = config.models[slot];
    const configured = isSlotConfigured(slot, cfg);
    entries.push({
      slot,
      label: SLOT_LABELS[slot],
      configured,
      kind: cfg.kind,
      kindLabel: kindLabel(cfg.kind),
      model: cfg.model || '',
      isMultimodal: slot === 'transcribe' ? Boolean(cfg.isMultimodal) : undefined,
      fallbackTo: !configured && slot !== 'transcribe' && isSlotConfigured('transcribe', t) && t.isMultimodal
        ? 'transcribe'
        : null,
    });
  }
  return {
    slots: entries,
    allConfigured: entries.every((e) => e.configured),
    mockMode: STEPS.every((slot) => config.models[slot].kind === 'mock'),
  };
}
