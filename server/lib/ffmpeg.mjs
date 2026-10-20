/**
 * ffmpeg 辅助：探测可用性、读取时长、按固定时长切片。
 * 没有 ffmpeg 时整个应用仍可用（改用百炼/Gemini 转写长文件），这里只做优雅降级。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.mjs';

let ffmpegCache = null;
let ffprobeCache = null;

function runVersion(bin, args) {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (result.error || result.status !== 0) return null;
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    const match = /version\s+(\S+)/.exec(out);
    return { available: true, version: match ? match[1] : 'unknown' };
  } catch {
    return null;
  }
}

export function detectFfmpeg() {
  if (ffmpegCache) return ffmpegCache;
  ffmpegCache = runVersion('ffmpeg', ['-version']) || { available: false, version: '' };
  return ffmpegCache;
}

export function detectFfprobe() {
  if (ffprobeCache) return ffprobeCache;
  ffprobeCache = runVersion('ffprobe', ['-version']) || { available: false, version: '' };
  return ffprobeCache;
}

function spawnCapture(bin, args, { signal, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new AppError(`无法启动 ${bin}：${err.message}`, { code: 'FFMPEG_SPAWN' }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new AppError(`${bin} 执行超时`, { code: 'FFMPEG_TIMEOUT' }));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new AppError('任务已取消', { code: 'ABORTED', status: 499 }));
      }
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(new AppError(`${bin} 运行失败：${err.message}`, { code: 'FFMPEG_ERROR' }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new AppError(`${bin} 退出码 ${code}：${stderr.split('\n').slice(-4).join(' ').trim()}`, {
        code: 'FFMPEG_FAILED',
        hint: '请确认音频文件没有损坏，或改用百炼/Gemini 转写',
      }));
    });
  });
}

/** 读取音频时长（毫秒），失败返回 null */
export async function probeDurationMs(filePath, { signal } = {}) {
  if (!detectFfprobe().available) return null;
  try {
    const { stdout } = await spawnCapture('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { signal, timeoutMs: 30000 });
    const seconds = Number(String(stdout).trim());
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
}

/**
 * 按时长切片（16kHz 单声道 mp3，体积小且各 ASR 都支持）。
 * 返回 [{ filePath, offsetMs }]，失败时抛 AppError。
 */
export async function splitAudio(filePath, { chunkSeconds = 600, outDir, signal, log } = {}) {
  if (!detectFfmpeg().available) {
    throw new AppError('没有找到 ffmpeg，无法切分长音频', {
      code: 'FFMPEG_MISSING',
      hint: '安装 ffmpeg 并加入 PATH，或改用百炼 Paraformer / Gemini 转写长音频',
    });
  }
  const durationMs = await probeDurationMs(filePath, { signal });
  if (!durationMs) {
    log?.warn?.('无法读取音频时长，将整文件转写');
    return [{ filePath, offsetMs: 0 }];
  }
  if (durationMs <= chunkSeconds * 1000) return [{ filePath, offsetMs: 0 }];

  await fs.mkdir(outDir, { recursive: true });
  const chunks = [];
  const total = Math.ceil(durationMs / (chunkSeconds * 1000));
  for (let i = 0; i < total; i += 1) {
    const startSec = i * chunkSeconds;
    const outPath = path.join(outDir, `chunk-${String(i + 1).padStart(3, '0')}.mp3`);
    log?.info?.(`切片 ${i + 1}/${total}：${startSec}s 起 ${chunkSeconds}s`);
    await spawnCapture('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(startSec),
      '-t', String(chunkSeconds),
      '-i', filePath,
      '-ac', '1', '-ar', '16000', '-b:a', '32k',
      outPath,
    ], { signal, timeoutMs: 600000 });
    const stat = await fs.stat(outPath).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new AppError(`切片 ${i + 1} 生成失败`, { code: 'FFMPEG_CHUNK_EMPTY' });
    }
    chunks.push({ filePath: outPath, offsetMs: startSec * 1000 });
  }
  return chunks;
}

export async function cleanupDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

export function ffmpegStatus() {
  const ffmpeg = detectFfmpeg();
  const ffprobe = detectFfprobe();
  return {
    available: ffmpeg.available,
    version: ffmpeg.version,
    ffprobe: ffprobe.available,
    hint: ffmpeg.available
      ? '长音频会自动切片转写'
      : '未检测到 ffmpeg：OpenAI 兼容转写接口只支持 ≤25MB 的文件，长音频建议改用百炼或 Gemini',
  };
}
