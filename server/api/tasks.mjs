/** 任务接口：创建、查询、SSE 进度、取消、重试、产物、打开文件夹。 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { json, readJsonBody, startSse } from '../http.mjs';
import { AppError } from '../errors.mjs';

function openInShell(target, reveal) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === 'win32') {
    command = 'explorer.exe';
    args = reveal ? [`/select,${target}`] : [target];
  } else if (platform === 'darwin') {
    command = 'open';
    args = reveal ? ['-R', target] : [target];
  } else {
    command = 'xdg-open';
    args = [reveal ? path.dirname(target) : target];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export function registerTaskRoutes(router, { manager, logger }) {
  router.get('/api/tasks', async (req, res) => {
    json(res, 200, { tasks: manager.list() });
  });

  router.post('/api/tasks', async (req, res) => {
    const body = await readJsonBody(req);
    const task = await manager.create({
      workspaceId: body.workspaceId,
      title: body.title,
      inputPath: body.inputPath,
      steps: body.steps,
      deliveryDir: body.deliveryDir,
    });
    json(res, 200, { task });
  });

  router.get('/api/tasks/:id', async (req, res, ctx) => {
    const task = manager.get(ctx.params.id);
    const logs = await manager.logs(ctx.params.id, 200);
    json(res, 200, { task, logs });
  });

  router.get('/api/tasks/:id/events', async (req, res, ctx) => {
    const taskId = ctx.params.id;
    const task = manager.get(taskId);

    let unsubTask = () => {};
    let unsubLog = () => {};
    const sse = startSse(req, res, {
      onClose: () => {
        unsubTask();
        unsubLog();
      },
    });

    sse.send('task', { type: 'task', task });

    const history = await manager.logs(taskId, 150);
    for (const line of history) {
      try {
        sse.send('log', JSON.parse(line));
      } catch { /* 忽略损坏的日志行 */ }
    }

    unsubTask = manager.subscribe(taskId, (event) => {
      sse.send(event.type, event);
      if (event.type === 'end') {
        setTimeout(() => sse.close(), 300);
      }
    });
    unsubLog = logger.subscribe((entry) => {
      if (entry.taskId === taskId) {
        sse.send('log', {
          at: entry.at,
          level: entry.level,
          message: entry.message,
          formatted: entry.formatted || entry.message,
        });
      }
    });
  });

  router.post('/api/tasks/:id/cancel', async (req, res, ctx) => {
    const task = manager.cancel(ctx.params.id);
    json(res, 200, { task });
  });

  router.post('/api/tasks/:id/retry', async (req, res, ctx) => {
    const task = await manager.retry(ctx.params.id);
    json(res, 200, { task });
  });

  router.delete('/api/tasks/:id', async (req, res, ctx) => {
    const deleteArtifacts = ['1', 'true'].includes(String(ctx.url.searchParams.get('deleteArtifacts') || ''));
    const result = await manager.remove(ctx.params.id, { deleteArtifacts });
    json(res, 200, result);
  });

  router.get('/api/tasks/:id/artifacts/:step', async (req, res, ctx) => {
    const artifact = await manager.readArtifact(ctx.params.id, ctx.params.step);
    json(res, 200, { artifact });
  });

  router.post('/api/open', async (req, res) => {
    const body = await readJsonBody(req);
    const target = path.resolve(String(body.path || ''));
    if (!body.path) throw new AppError('缺少要打开的路径', { code: 'PATH_REQUIRED' });
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat) {
      throw new AppError('这个路径已经不存在了', {
        code: 'PATH_NOT_FOUND',
        hint: '文件可能被移动或删除',
      });
    }
    openInShell(target, Boolean(body.reveal) && stat.isFile());
    json(res, 200, { ok: true });
  });
}
