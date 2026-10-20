import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildTranscriptMarkdown,
  buildPolishMarkdown,
  buildMinutesMarkdown,
  resolveArtifactPath,
  baseNameOf,
  writeArtifact,
  segmentsToTimestampedText,
} from '../../server/pipeline/artifacts.mjs';

test('buildTranscriptMarkdown 包含元信息与时间段', () => {
  const md = buildTranscriptMarkdown({
    sourceName: '周会.mp3',
    inputBytes: 2 * 1024 * 1024,
    durationMs: 65_000,
    modelLabel: 'whisper-1 · OpenAI 兼容',
    quality: 'exact',
    segments: [
      { startMs: 0, endMs: 5300, text: '大家好' },
      { startMs: 5300, endMs: 12_000, text: '开始吧' },
    ],
    createdAt: new Date(2026, 1, 14, 15, 30),
  });
  assert.match(md, /^# 转写原文：周会\.mp3/);
  assert.match(md, /生成时间：2026-02-14 15:30/);
  assert.match(md, /时间戳：精确/);
  assert.match(md, /^\[00:00:00\.0 - 00:00:05\.3\] 大家好$/m);
  assert.match(md, /^\[00:00:05\.3 - 00:00:12\.0\] 开始吧$/m);
  assert.match(md, /时长约 1 分 5 秒/);
});

test('buildTranscriptMarkdown 无时间戳时输出全文', () => {
  const md = buildTranscriptMarkdown({
    sourceName: 'a.wav',
    modelLabel: 'mock',
    quality: 'none',
    segments: [{ startMs: 0, endMs: null, text: '整段内容' }],
  });
  assert.match(md, /## 全文/);
  assert.match(md, /整段内容/);
  assert.doesNotMatch(md, /逐段原文/);
});

test('buildPolishMarkdown / buildMinutesMarkdown 结构', () => {
  const polish = buildPolishMarkdown({
    sourceName: '周会.mp3',
    modelLabel: 'deepseek-chat',
    body: '第一段。\n\n第二段。',
    basedOn: '转写原文（已自动去掉时间戳）',
    charCount: 8,
  });
  assert.match(polish, /^# 润色稿：周会\.mp3/);
  assert.match(polish, /## 正文/);
  assert.match(polish, /第一段。/);

  const minutes = buildMinutesMarkdown({
    sourceName: '周会.mp3',
    modelLabel: 'deepseek-chat',
    body: '## 会议信息\n- 主题：排期',
    basedOn: '润色稿',
  });
  assert.match(minutes, /^# 会议纪要：周会\.mp3/);
  assert.match(minutes, /## 会议信息/);
});

test('baseNameOf 去掉扩展名', () => {
  assert.equal(baseNameOf('D:/会议/产品周会 3月.mp3'), '产品周会 3月');
  assert.equal(baseNameOf('/tmp/a.b.c.md'), 'a.b.c');
  assert.equal(baseNameOf('没有扩展名'), '没有扩展名');
});

test('resolveArtifactPath 生成不冲突的文件名', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mns-artifact-'));
  try {
    const createdAt = new Date(2026, 1, 14, 9, 5);
    const first = await resolveArtifactPath({ deliveryDir: dir, baseName: '周会', suffix: '转写原文', createdAt });
    assert.equal(path.basename(first), '周会_20260214-0905_转写原文.md');
    await writeArtifact(first, '# 测试');
    const second = await resolveArtifactPath({ deliveryDir: dir, baseName: '周会', suffix: '转写原文', createdAt });
    assert.equal(path.basename(second), '周会_20260214-0905_转写原文 (2).md');
    await writeArtifact(second, '# 测试2');
    const third = await resolveArtifactPath({ deliveryDir: dir, baseName: '周会', suffix: '转写原文', createdAt });
    assert.equal(path.basename(third), '周会_20260214-0905_转写原文 (3).md');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeArtifact 返回字节数与字数', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mns-write-'));
  try {
    const file = path.join(dir, 'x.md');
    const info = await writeArtifact(file, '你好 世界');
    assert.equal(info.chars, 4);
    assert.ok(info.bytes > 0);
    const text = await fs.readFile(file, 'utf8');
    assert.ok(text.endsWith('\n'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('segmentsToTimestampedText 生成 mm:ss 引用', () => {
  const text = segmentsToTimestampedText([
    { startMs: 0, endMs: 1000, text: '第一句' },
    { startMs: 750_000, endMs: 760_000, text: '第二句' },
  ]);
  assert.equal(text, '[00:00:00] 第一句\n[00:12:30] 第二句');
});
