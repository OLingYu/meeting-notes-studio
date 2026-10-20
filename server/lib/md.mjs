/** Markdown 产物的小工具：标题、元信息块、文件名安全化。 */

export function heading(level, text) {
  const clamped = Math.min(6, Math.max(1, Number(level) || 1));
  return `${'#'.repeat(clamped)} ${text}`;
}

/** 产物头部的元信息列表：`- 键：值` */
export function metaBlock(rows) {
  return rows
    .filter((row) => row && row[1] !== undefined && row[1] !== null && String(row[1]) !== '')
    .map(([key, value]) => `- ${key}：${value}`)
    .join('\n');
}

/** 行内转义：避免用户数据里的字符被当成 Markdown 结构 */
export function escapeInline(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]])/g, '\\$1')
    .replace(/\n/g, ' ');
}

/** Windows/通用文件名安全化 */
export function safeFileBase(name, { maxLength = 80, fallback = '未命名' } = {}) {
  let base = String(name ?? '');
  // 去掉扩展名部分由调用方处理，这里只清理非法字符
  base = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  base = base.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!base) base = fallback;
  const chars = Array.from(base);
  if (chars.length > maxLength) base = chars.slice(0, maxLength).join('');
  return base;
}
