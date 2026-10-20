import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, normalizeConfig, isSlotConfigured } from '../../server/config.mjs';
import {
  normalizeSteps,
  inputKindFor,
  resolveModels,
  slotStatus,
  validationForInput,
} from '../../server/pipeline/resolve.mjs';

function makeConfig(overrides = {}) {
  const base = defaultConfig();
  return normalizeConfig({
    ...base,
    models: {
      transcribe: { ...base.models.transcribe, ...(overrides.transcribe || {}) },
      polish: { ...base.models.polish, ...(overrides.polish || {}) },
      minutes: { ...base.models.minutes, ...(overrides.minutes || {}) },
    },
  });
}

const OPENAI_ASR = {
  kind: 'openai-asr',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'whisper-1',
};
const GEMINI_MM = {
  kind: 'gemini-audio',
  isMultimodal: true,
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: 'sk-test',
  model: 'gemini-2.5-flash',
};
const CHAT = {
  kind: 'openai-chat',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
};

test('normalizeSteps 过滤非法项并固定顺序', () => {
  assert.deepEqual(normalizeSteps(['minutes', 'transcribe', 'bogus']), ['transcribe', 'minutes']);
  assert.deepEqual(normalizeSteps('transcribe'), []);
  assert.deepEqual(normalizeSteps([]), []);
});

test('inputKindFor：勾了转写就要音频，否则文本', () => {
  assert.equal(inputKindFor(['transcribe']), 'audio');
  assert.equal(inputKindFor(['transcribe', 'minutes']), 'audio');
  assert.equal(inputKindFor(['polish', 'minutes']), 'text');
  assert.equal(inputKindFor(['minutes']), 'text');
});

test('validationForInput 校验扩展名', () => {
  assert.equal(validationForInput('audio', 'D:/x/会议.mp3').ok, true);
  assert.equal(validationForInput('audio', 'D:/x/会议.txt').ok, false);
  assert.equal(validationForInput('text', 'D:/x/notes.md').ok, true);
  assert.equal(validationForInput('text', 'D:/x/audio.wav').ok, false);
});

test('什么都没配置时，全部流程都缺模型', () => {
  const config = makeConfig();
  const { plan, missing, ready } = resolveModels(config, ['transcribe', 'polish', 'minutes']);
  assert.equal(ready, false);
  assert.equal(missing.length, 3);
  assert.equal(plan.transcribe, null);
  assert.equal(plan.polish, null);
  assert.equal(plan.minutes, null);
});

test('三个模型都配置时直接使用、无回退', () => {
  const config = makeConfig({ transcribe: OPENAI_ASR, polish: CHAT, minutes: CHAT });
  const { plan, missing, ready } = resolveModels(config, ['transcribe', 'polish', 'minutes']);
  assert.equal(ready, true);
  assert.equal(missing.length, 0);
  assert.equal(plan.transcribe.fallback, false);
  assert.equal(plan.polish.fallback, false);
  assert.equal(plan.polish.model, 'deepseek-chat');
  assert.equal(plan.polish.chatKind, 'openai-chat');
});

test('多模态转写模型可以兜底润色与纪要', () => {
  const config = makeConfig({ transcribe: GEMINI_MM });
  const { plan, missing, ready } = resolveModels(config, ['transcribe', 'polish', 'minutes']);
  assert.equal(ready, true);
  assert.equal(missing.length, 0);
  assert.equal(plan.polish.fallback, true);
  assert.equal(plan.polish.source, 'transcribe');
  assert.equal(plan.polish.kind, 'gemini-audio');
  assert.equal(plan.polish.chatKind, 'gemini-chat');
  assert.equal(plan.minutes.fallback, true);
});

test('专用 ASR 模型不能兜底', () => {
  const config = makeConfig({ transcribe: OPENAI_ASR });
  const { missing, ready, plan } = resolveModels(config, ['transcribe', 'polish', 'minutes']);
  assert.equal(ready, false);
  assert.equal(missing.length, 2);
  assert.equal(plan.polish, null);
  assert.ok(missing.some((m) => m.slot === 'polish'));
  assert.ok(missing.some((m) => m.slot === 'minutes'));
});

test('多模态但未勾选 isMultimodal 时不兜底', () => {
  const config = makeConfig({ transcribe: { ...GEMINI_MM, isMultimodal: false } });
  const { missing } = resolveModels(config, ['transcribe', 'polish']);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].slot, 'polish');
});

test('只勾选部分流程时只校验需要的槽位', () => {
  const config = makeConfig({ transcribe: OPENAI_ASR });
  assert.equal(resolveModels(config, ['transcribe']).ready, true);
  const minutesOnly = resolveModels(config, ['minutes']);
  assert.equal(minutesOnly.ready, false);
  assert.equal(minutesOnly.plan.transcribe, null);
});

test('multimodal-chat 槽位兜底时走 openai 对话协议', () => {
  const config = makeConfig({
    transcribe: {
      kind: 'multimodal-chat',
      isMultimodal: true,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-test',
      model: 'qwen3-omni-flash',
    },
  });
  const { plan } = resolveModels(config, ['transcribe', 'polish']);
  assert.equal(plan.polish.chatKind, 'openai-chat');
});

test('isSlotConfigured 与 slotStatus 一致', () => {
  const config = makeConfig({ transcribe: GEMINI_MM, polish: CHAT });
  assert.equal(isSlotConfigured('transcribe', config.models.transcribe), true);
  assert.equal(isSlotConfigured('minutes', config.models.minutes), false);
  const status = slotStatus(config);
  assert.equal(status.allConfigured, false);
  const minutesSlot = status.slots.find((s) => s.slot === 'minutes');
  assert.equal(minutesSlot.configured, false);
  assert.equal(minutesSlot.fallbackTo, 'transcribe');
});

test('mock 模型无需密钥即视为已配置', () => {
  const config = makeConfig({
    transcribe: { kind: 'mock', isMultimodal: true },
    polish: { kind: 'mock' },
    minutes: { kind: 'mock' },
  });
  assert.equal(isSlotConfigured('polish', config.models.polish), true);
  assert.equal(slotStatus(config).mockMode, true);
  assert.equal(resolveModels(config, ['transcribe', 'polish', 'minutes']).ready, true);
});
