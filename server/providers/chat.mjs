/** 文本模型（润色/纪要）统一入口：把槽位类型映射到具体协议实现。 */

import * as openai from './openai.mjs';
import * as gemini from './gemini.mjs';
import * as mock from './mock.mjs';
import { AppError } from '../errors.mjs';
import { kindLabel } from '../config.mjs';

/**
 * 转写槽位被当成多模态模型使用时，也要能走对话补全：
 * gemini-audio → gemini.chat，multimodal-chat → openai.chat，mock → mock.chat。
 */
export function chatKindOf(kind) {
  if (kind === 'gemini-chat' || kind === 'gemini-audio') return 'gemini-chat';
  if (kind === 'mock') return 'mock';
  if (kind === 'openai-chat' || kind === 'multimodal-chat') return 'openai-chat';
  return null;
}

const IMPL = {
  'openai-chat': openai,
  'gemini-chat': gemini,
  mock,
};

export async function chatComplete(cfg, options = {}) {
  const kind = chatKindOf(cfg?.kind);
  const impl = IMPL[kind];
  if (!impl) {
    throw new AppError(`这个模型类型不支持文本生成：${kindLabel(cfg?.kind)}`, {
      code: 'CHAT_UNSUPPORTED',
      hint: '请在设置里换一个支持对话补全的模型',
    });
  }
  return impl.chat(cfg, options);
}
