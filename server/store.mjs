/** 数据目录与 JSON 持久化：原子写 + 串行化，避免并发写坏文件。 */

import fs from 'node:fs/promises';
import path from 'node:path';

const writeChains = new Map();

export function nowIso() {
  return new Date().toISOString();
}

export function shortId(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonInner(filePath, data, { backup = false } = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  if (backup) {
    try {
      await fs.copyFile(filePath, `${filePath}.bak`);
    } catch { /* 首次写入没有备份源，忽略 */ }
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

/** 同一文件的写入串行化：后写覆盖前写，但不会交错 */
export function writeJson(filePath, data, options = {}) {
  const key = path.resolve(filePath);
  const prev = writeChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => writeJsonInner(key, data, options));
  writeChains.set(key, next);
  next.catch(() => {}).finally(() => {
    if (writeChains.get(key) === next) writeChains.delete(key);
  });
  return next;
}

export async function appendLine(filePath, line) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${line}\n`, 'utf8');
}

/** 读取文件尾部若干行（任务日志恢复用） */
export async function readTailLines(filePath, maxLines = 300) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    return [];
  }
}

export async function listDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function statSafe(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}
