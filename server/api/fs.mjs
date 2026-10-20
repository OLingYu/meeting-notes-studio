/** 文件系统浏览接口：系统原生文件夹选择、目录浏览、枚举工作区内文件。 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { json, readJsonBody } from '../http.mjs';
import { AppError } from '../errors.mjs';
import { AUDIO_EXTS, TEXT_EXTS, extOf } from '../lib/text.mjs';
import { pathWithin } from '../pipeline/runner.mjs';
import { pickDirectoryNative } from '../lib/native-dialog.mjs';

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '.svn']);

function shouldSkip(name) {
  const lower = name.toLowerCase();
  if (SKIP_DIRS.has(lower)) return true;
  if (name.startsWith('.')) return true;
  return false;
}

function listWindowsDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) drives.push({ name: `${letter}:`, path: root });
    } catch { /* 忽略无法访问的盘符 */ }
  }
  return drives;
}

function listUnixRoots() {
  return [{ name: '/', path: '/' }];
}

function parentOf(target) {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  return parent === resolved ? null : parent;
}

function filterExts(filter) {
  if (filter === 'audio') return AUDIO_EXTS;
  if (filter === 'text') return TEXT_EXTS;
  return null;
}

export function registerFsRoutes(router) {
  router.get('/api/fs/drives', async (req, res) => {
    const drives = process.platform === 'win32' ? listWindowsDrives() : listUnixRoots();
    json(res, 200, {
      drives,
      home: process.env.USERPROFILE || process.env.HOME || '',
      platform: process.platform,
    });
  });

  /** 弹出系统原生文件夹选择窗口（等待用户选完才返回） */
  router.post('/api/fs/pick-directory', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const controller = new AbortController();
    res.on('close', () => {
      // 浏览器关掉页面/断开时，别让系统对话框一直挂着
      if (!res.writableEnded) controller.abort();
    });
    const result = await pickDirectoryNative({
      title: String(body.title || '选择文件夹'),
      initialPath: String(body.initialPath || ''),
      signal: controller.signal,
      runner: ctx.pickDirectoryRunner || undefined,
    });
    json(res, 200, {
      native: true,
      canceled: Boolean(result.canceled),
      path: result.path || null,
    });
  });

  router.get('/api/fs/list', async (req, res, ctx) => {
    const url = ctx.url;
    const rawPath = url.searchParams.get('path');
    const filter = url.searchParams.get('filter') || 'all';
    const includeFiles = url.searchParams.get('dirOnly') !== '1';

    let target = rawPath ? path.resolve(rawPath) : '';
    if (!target) {
      const drives = process.platform === 'win32' ? listWindowsDrives() : listUnixRoots();
      json(res, 200, {
        path: '',
        parent: null,
        name: '我的电脑',
        roots: drives,
        dirs: drives.map((d) => ({ name: d.name, path: d.path })),
        files: [],
      });
      return;
    }

    const stat = await fsp.stat(target).catch(() => null);
    if (!stat) {
      throw new AppError(`目录不存在：${target}`, {
        code: 'DIR_NOT_FOUND',
        status: 404,
        hint: '确认路径拼写，或从盘符重新进入',
      });
    }
    if (!stat.isDirectory()) {
      throw new AppError('这个路径不是文件夹', { code: 'NOT_A_DIRECTORY' });
    }

    let entries = [];
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      throw new AppError(`没有权限读取该目录：${err.code || err.message}`, {
        code: 'DIR_UNREADABLE',
        status: 403,
        hint: '换一个目录，或用管理员身份运行 start.bat',
      });
    }

    const exts = filterExts(filter);
    const dirs = [];
    const files = [];

    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue;
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: full });
        continue;
      }
      if (!entry.isFile() || !includeFiles) continue;
      const ext = extOf(entry.name);
      if (exts && !exts.includes(ext)) continue;
      const info = await fsp.stat(full).catch(() => null);
      if (!info) continue;
      files.push({
        name: entry.name,
        path: full,
        size: info.size,
        mtime: info.mtime.toISOString(),
        ext,
      });
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

    json(res, 200, {
      path: target,
      parent: parentOf(target),
      name: path.basename(target) || target,
      dirs,
      files,
    });
  });

  router.post('/api/fs/mkdir', async (req, res) => {
    const body = await readJsonBody(req);
    const base = String(body.path || '').trim();
    const name = String(body.name || '').trim();
    if (!base || !name) throw new AppError('缺少目录路径或名称', { code: 'MKDIR_PARAMS' });
    if (/[\\/:*?"<>|]/.test(name)) {
      throw new AppError('文件夹名不能包含 \\ / : * ? " < > |', { code: 'INVALID_DIR_NAME' });
    }
    const target = path.join(path.resolve(base), name);
    const exists = await fsp.stat(target).catch(() => null);
    if (exists) throw new AppError('同名文件夹已经存在', { code: 'DIR_EXISTS' });
    await fsp.mkdir(target, { recursive: false });
    json(res, 200, { ok: true, path: target, name });
  });

  /** 枚举某个工作区里可选的文件（限制深度与数量，避免超大目录卡住界面） */
  router.get('/api/workspaces/:id/files', async (req, res, ctx) => {
    const url = ctx.url;
    const { id } = ctx.params;
    const config = ctx.configStore.get();
    const workspace = config.workspaces.find((w) => w.id === id);
    if (!workspace) throw new AppError('工作区不存在', { code: 'WORKSPACE_NOT_FOUND', status: 404 });

    const subdir = url.searchParams.get('subdir') || '';
    const filter = url.searchParams.get('filter') || 'all';
    const root = path.resolve(workspace.path);
    const target = subdir ? path.resolve(root, subdir) : root;
    if (!pathWithin(root, target)) throw new AppError('子目录超出工作区范围', { code: 'OUT_OF_WORKSPACE' });

    const exts = filterExts(filter);
    const files = [];
    const dirs = [];
    const MAX_FILES = 800;
    const MAX_DEPTH = 3;

    async function walk(dir, depth) {
      if (files.length >= MAX_FILES) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        if (shouldSkip(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH) {
            dirs.push({ name: entry.name, path: full, relPath: path.relative(root, full) });
            await walk(full, depth + 1);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = extOf(entry.name);
        if (exts && !exts.includes(ext)) continue;
        const info = await fsp.stat(full).catch(() => null);
        if (!info) continue;
        files.push({
          name: entry.name,
          path: full,
          relPath: path.relative(root, full),
          size: info.size,
          mtime: info.mtime.toISOString(),
          ext,
          kind: AUDIO_EXTS.includes(ext) ? 'audio' : TEXT_EXTS.includes(ext) ? 'text' : 'other',
        });
      }
    }

    await walk(target, 0);
    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    dirs.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'));
    json(res, 200, {
      workspace: { id: workspace.id, name: workspace.name, path: workspace.path },
      subdir,
      files,
      dirs,
      truncated: files.length >= MAX_FILES,
      audioExts: AUDIO_EXTS,
      textExts: TEXT_EXTS,
    });
  });
}
