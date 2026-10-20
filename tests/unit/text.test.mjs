import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrt,
  parseVtt,
  parseSubtitle,
  looksLikeSubtitle,
  subtitleToPlainText,
  stripTimestampPrefixes,
  parseTimestampedSegments,
  chunkText,
  charCount,
  extOf,
} from '../../server/lib/text.mjs';

test('parseSrt 解析序号/时间/文本', () => {
  const srt = [
    '1',
    '00:00:00,000 --> 00:00:05,300',
    '大家好，今天开个短会。',
    '',
    '2',
    '00:00:05,300 --> 00:00:12,500',
    '主要同步一下进度。',
  ].join('\n');
  const segments = parseSrt(srt);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[0].endMs, 5300);
  assert.equal(segments[1].text, '主要同步一下进度。');
});

test('parseVtt 解析并跳过 WEBVTT 头', () => {
  const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:03.500', '第一句话'].join('\n');
  const segments = parseVtt(vtt);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startMs, 1000);
  assert.equal(segments[0].text, '第一句话');
});

test('looksLikeSubtitle / parseSubtitle 自动判断', () => {
  assert.equal(looksLikeSubtitle('1\n00:00:00,000 --> 00:00:01,000\nhi'), true);
  assert.equal(looksLikeSubtitle('普通文本，没有箭头'), false);
  const plain = parseSubtitle('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n你好');
  assert.equal(plain.length, 1);
});

test('subtitleToPlainText 拼接纯文本', () => {
  const text = subtitleToPlainText([
    { startMs: 0, endMs: 1, text: '第一句' },
    { startMs: 1, endMs: 2, text: '第二句' },
  ]);
  assert.equal(text, '第一句\n第二句');
});

test('stripTimestampPrefixes 去掉行首时间段', () => {
  const text = '[00:00:00.0 - 00:00:05.3] 大家好\n[00:00:05.3 - 00:00:11.8] 开始吧';
  assert.equal(stripTimestampPrefixes(text), '大家好\n开始吧');
});

test('parseTimestampedSegments 兼容多种时间戳写法', () => {
  const raw = [
    '[00:00:00.0 - 00:00:05.3] 第一段内容',
    '00:05.3 - 00:11.8 第二段内容',
    '[00:11.8] 第三段内容',
    '这一行没有时间戳',
    '[00:20.0 ~ 00:25.0] 第四段内容',
  ].join('\n');
  const { segments, orphanLines } = parseTimestampedSegments(raw);
  assert.equal(orphanLines.length, 1);
  assert.equal(segments.length, 4);
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[0].endMs, 5300);
  assert.equal(segments[1].text, '第二段内容');
  // 只有起始时间的段落，结束时间用下一段开始时间补齐
  assert.equal(segments[2].endMs, 20000);
  assert.equal(segments[3].endMs, 25000);
});

test('chunkText 不超长且带重叠', () => {
  const lines = [];
  for (let i = 0; i < 200; i += 1) lines.push(`第 ${i} 行的会议内容，大概这么长一句话。`);
  const text = lines.join('\n');
  const chunks = chunkText(text, { maxChars: 600, overlapChars: 80 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 600, `块长度 ${chunk.length} 超过上限`);
  // 相邻块有重叠（后一块开头出现在前一块里）
  const overlapHead = chunks[1].split('\n')[0];
  assert.ok(chunks[0].includes(overlapHead));
});

test('chunkText 处理超长单行', () => {
  const huge = 'a'.repeat(5000);
  const chunks = chunkText(huge, { maxChars: 1000, overlapChars: 100 });
  assert.ok(chunks.length >= 5);
  for (const chunk of chunks) assert.ok(chunk.length <= 1000);
  assert.equal(chunks.join('').length, 5000);
});

test('chunkText 短文本不切分', () => {
  assert.deepEqual(chunkText('只有一句话', { maxChars: 6000 }), ['只有一句话']);
  assert.deepEqual(chunkText('', { maxChars: 10 }), []);
});

test('charCount / extOf', () => {
  assert.equal(charCount('你好 世界\n'), 4);
  assert.equal(extOf('会议录音.MP3'), '.mp3');
  assert.equal(extOf('没有扩展名'), '');
});
