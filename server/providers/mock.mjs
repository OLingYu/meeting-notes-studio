/**
 * 内置模拟模型：不联网、不消耗额度，用来试用流程与离线测试。
 * 输出是确定性的（基于输入内容），方便断言。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { formatTimestamp } from '../lib/time.mjs';

const SAMPLE_LINES = [
  '各位好，今天这次会议主要讨论三件事，大概四十分钟。',
  '第一是下个季度的产品排期，第二是转写工具的采购方案，第三是团队的人员安排。',
  '先说排期。目前看第一版要在十月底之前交付，主要风险在数据接入这块。',
  '数据接入那边我们还需要再评估一下，大概需要两周时间。',
  '采购方案我倾向于先按量付费，等用量稳定之后再考虑包年。',
  '这样的话预算大概能控制在每个月八百到一千之间。',
  '人员安排上，前端还缺一个人，我建议从内部转岗优先考虑。',
  '好，那这三件事我们分头推进，下周三之前把细节发群里。',
  '另外提醒一下，这次会议的录音和纪要都要归档到工作区里。',
  '有没有补充的？没有的话我们今天就到这里，谢谢大家。',
];

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('任务已取消'), { code: 'ABORTED' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('任务已取消'), { code: 'ABORTED' }));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) % 1000000007;
  }
  return h;
}

export function modelLabel() {
  return '内置模拟模型';
}

/** 生成带精确时间戳的假转写 */
export async function transcribe(cfg, { filePath, signal, log } = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    const { AppError } = await import('../errors.mjs');
    throw new AppError('找不到或无法读取音频文件', { code: 'FILE_NOT_FOUND' });
  }
  await delay(120, signal);

  const base = path.basename(filePath);
  const count = Math.max(4, Math.min(SAMPLE_LINES.length, Math.round(stat.size / 2048) + 4));
  const seed = hashText(base);
  const segments = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const duration = 9000 + ((seed + i * 37) % 9) * 700;
    const text = SAMPLE_LINES[(seed + i) % SAMPLE_LINES.length];
    segments.push({ startMs: cursor, endMs: cursor + duration, text });
    cursor += duration;
  }
  log?.info?.(`模拟转写完成：${segments.length} 段，约 ${formatTimestamp(cursor)}`);
  return {
    segments,
    text: segments.map((s) => s.text).join('\n'),
    quality: 'exact',
    usage: { sttSeconds: Math.round(cursor / 1000) },
    label: modelLabel(),
  };
}

function extractOriginal(user) {
  const match = /【原文开始】([\s\S]*?)【原文结束】/.exec(String(user || ''));
  if (match) return match[1].trim();
  const marker = /【要点开始】([\s\S]*?)【要点结束】/.exec(String(user || ''));
  if (marker) return marker[1].trim();
  return String(user || '').trim();
}

function mockPolish(user) {
  const original = extractOriginal(user);
  const lines = original.split('\n').map((l) => l.trim()).filter(Boolean);
  const cleaned = lines
    .map((line) => line.replace(/^(嗯|啊|那个|就是说|然后就是)[，、\s]*/g, ''))
    .join('');
  const head = cleaned.slice(0, 220);
  const tail = cleaned.slice(220, 440);
  return [
    `（模拟润色）本次会议围绕排期、采购与人员安排三项议题展开。${head}`,
    tail ? `与会人员就上述内容达成初步共识，${tail}` : '与会人员就上述内容达成初步共识，并明确了后续分工。',
    '（以上内容由内置模拟模型生成，仅用于验证流程，不消耗任何额度）',
  ].join('\n\n');
}

function mockMinutes(user) {
  const original = extractOriginal(user);
  const chars = original.replace(/\s/g, '').length;
  return [
    '## 会议信息',
    `- 议题：产品排期、工具采购、人员安排（模拟数据，参考输入 ${chars} 字）`,
    '- 时间：未指定',
    '',
    '## 一句话结论',
    '三项议题均形成初步结论，细节由各自负责人下周三前同步。',
    '',
    '## 核心议题与结论',
    '1. **产品排期**：第一版目标十月底交付，数据接入存在约两周的不确定性，需要提前评估。',
    '2. **工具采购**：倾向于先按量付费，用量稳定后再评估包年方案，月预算控制在 800–1000 元。',
    '3. **人员安排**：前端缺一人，优先考虑内部转岗。',
    '',
    '## 待办事项',
    '| 事项 | 负责人 | 时间 |',
    '| --- | --- | --- |',
    '| 评估数据接入风险 | 未指定 | 下周三前 |',
    '| 输出采购方案对比 | 未指定 | 下周三前 |',
    '| 内部转岗人选推荐 | 未指定 | 未指定 |',
    '',
    '## 风险与待确认问题',
    '- 数据接入耗时可能影响第一版交付时间。',
    '- 按量付费的单价与阶梯价尚未确认。',
    '',
    '（以上内容由内置模拟模型生成，仅用于验证流程，不消耗任何额度）',
  ].join('\n');
}

export async function chat(cfg, { system, user, signal, log } = {}) {
  await delay(80, signal);
  const systemText = String(system || '');
  let text;
  if (/纪要/.test(systemText) || /会议纪要/.test(systemText)) {
    text = mockMinutes(user);
  } else if (/润色/.test(systemText) || /编辑/.test(systemText)) {
    text = mockPolish(user);
  } else {
    text = `（模拟回复）已收到 ${String(user || '').length} 字输入。`;
  }
  const chars = String(user || '').length;
  return {
    text,
    usage: { tokensIn: Math.round(chars / 2), tokensOut: Math.round(text.length / 2) },
    label: modelLabel(),
  };
}

export async function testConnection() {
  return {
    ok: true,
    latencyMs: 1,
    message: '内置模拟模型随时可用（不会调用任何外部接口）',
  };
}
