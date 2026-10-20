/** 时间格式化与解析工具。所有产物里的时间戳都走这里，保证格式一致。 */

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 毫秒 → `HH:MM:SS.d`（例：`00:01:05.3`）
 * 固定三段式，方便产物里对齐与后续解析。
 */
export function formatTimestamp(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const tenths = Math.floor((total % 1000) / 100);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
}

/** `[00:00:05.3 - 00:00:11.8]`；结束时间未知时只显示开始时间 */
export function formatRange(startMs, endMs) {
  const start = formatTimestamp(startMs);
  if (endMs === null || endMs === undefined || Number.isNaN(Number(endMs))) return `[${start}]`;
  return `[${start} - ${formatTimestamp(endMs)}]`;
}

/**
 * 解析各种时间戳写法：`1:02:03.4`、`02:03`、`[00:13]`、`00:13.5`、`75.4s`、`93`（纯秒）
 * 解析不出来返回 null。
 */
export function parseTimestamp(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : null;
  let text = String(input).trim();
  if (!text) return null;
  text = text.replace(/^[[(【（<]+/, '').replace(/[)\]}】）>\]]+$/, '').trim();
  if (!text) return null;

  const clock = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(text);
  if (clock) {
    const hours = Number(clock[1] || 0);
    const minutes = Number(clock[2] || 0);
    const seconds = Number(clock[3] || 0);
    const frac = clock[4] ? Number(`0.${clock[4]}`) : 0;
    return Math.round(((hours * 60 + minutes) * 60 + seconds + frac) * 1000);
  }

  const secondsOnly = /^(\d+(?:[.,]\d+)?)\s*(?:s|sec|secs|秒)?$/i.exec(text);
  if (secondsOnly) return Math.round(Number(secondsOnly[1].replace(',', '.')) * 1000);

  return null;
}

/** 时长 → 「1 小时 2 分 3 秒」 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (!total) return '0 秒';
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.round((total % 60000) / 1000);
  const parts = [];
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分`);
  if (seconds && !hours) parts.push(`${seconds} 秒`);
  if (!parts.length) parts.push('不到 1 秒');
  return parts.join(' ');
}

/** 本地时区的 `YYYY-MM-DD HH:mm` */
export function formatDateTime(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `YYYYMMDD-HHmm`，用于产物文件名 */
export function fileStamp(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** `HH:mm:ss`，用于日志 */
export function formatClock(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 毫秒 → `mm:ss`（进度、日志里的简短计时） */
export function formatShort(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor(total / 1000) % 60;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}
