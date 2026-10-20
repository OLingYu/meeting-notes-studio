import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimestamp,
  formatRange,
  parseTimestamp,
  formatDuration,
  formatDateTime,
  fileStamp,
} from '../../server/lib/time.mjs';

test('formatTimestamp 固定三段式并保留十分之一秒', () => {
  assert.equal(formatTimestamp(0), '00:00:00.0');
  assert.equal(formatTimestamp(5300), '00:00:05.3');
  assert.equal(formatTimestamp(3723456), '01:02:03.4');
  assert.equal(formatTimestamp(-100), '00:00:00.0');
  assert.equal(formatTimestamp(null), '00:00:00.0');
});

test('formatRange 处理已知与未知结束时间', () => {
  assert.equal(formatRange(0, 12500), '[00:00:00.0 - 00:00:12.5]');
  assert.equal(formatRange(5000, null), '[00:00:05.0]');
  assert.equal(formatRange(5000), '[00:00:05.0]');
});

test('parseTimestamp 兼容多种写法', () => {
  assert.equal(parseTimestamp('00:00:05.3'), 5300);
  assert.equal(parseTimestamp('[00:13]'), 13000);
  assert.equal(parseTimestamp('1:02:03.4'), 3723400);
  assert.equal(parseTimestamp('02:03'), 123000);
  assert.equal(parseTimestamp('75.4s'), 75400);
  assert.equal(parseTimestamp('75 秒'), 75000);
  assert.equal(parseTimestamp(1500), 1500);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp('不是时间'), null);
});

test('formatDuration 输出中文时长', () => {
  assert.equal(formatDuration(0), '0 秒');
  assert.match(formatDuration(3_800_000), /1 小时 3 分/);
  assert.match(formatDuration(43 * 60 * 1000), /43 分/);
  assert.match(formatDuration(12_000), /12 秒/);
});

test('formatDateTime 与 fileStamp 稳定输出', () => {
  const date = new Date(2026, 1, 14, 15, 30, 5);
  assert.equal(formatDateTime(date), '2026-02-14 15:30');
  assert.equal(fileStamp(date), '20260214-1530');
});
