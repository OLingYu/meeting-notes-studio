/** 工作区管理：新增时校验存在性、可读性、可写性。 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { json, readJsonBody } from '../http.mjs';
import { AppError } from '../errors.mjs';
import { shortId } from '../store.mjs';

async function describeWorkspace(workspace) {
  const stat = await fsp.stat(workspace.path).catch(() => null);
  let writable = false;
  if (stat?.isDirectory()) {
    try {
      await fsp.access(workspace.path, fs.constants.W_OK);
      writable = true;
    } catch { writable = false; }
  }
  return {
    ...workspace,
    exists: Boolean(stat?.isDirectory()),
    writable,
    path: workspace.path,
  };
}

async function validateDir(targetRaw, label) {
  const target = path.resolve(String(targetRaw || ''));
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new AppError(`${label}不是一个存在的文件夹：${target}`, {
      code: 'DIR_NOT_FOUND',
      hint: '请用目录浏览器重新选择',
    });
  }
  try {
    await fsp.access(target, fs.constants.W_OK);
  } catch {
    throw new AppError(`${label}没有写权限：${target}`, {
      code: 'DIR_NOT_WRITABLE',
      hint: '换一个有写权限的文件夹（例如放在「文档」或自己的项目目录下）',
    });
  }
  return target;
}

export function registerWorkspaceRoutes(router, { configStore, logger }) {
  router.get('/api/workspaces', async (req, res) => {
    const config = configStore.get();
    const workspaces = await Promise.all(config.workspaces.map(describeWorkspace));
    json(res, 200, { workspaces, lastWorkspaceId: config.ui?.lastWorkspaceId || '' });
  });

  router.post('/api/workspaces', async (req, res) => {
    const body = await readJsonBody(req);
    const resolvedPath = await validateDir(body.path, '工作区');
    let deliveryPath = '';
    if (body.defaultDeliveryPath) {
      deliveryPath = await validateDir(body.defaultDeliveryPath, '默认交付区');
    }
    const config = configStore.get();
    const duplicated = config.workspaces.find(
      (w) => path.resolve(w.path).toLowerCase() === resolvedPath.toLowerCase(),
    );
    if (duplicated) {
      throw new AppError('这个文件夹已经添加为工作区了', {
        code: 'WORKSPACE_EXISTS',
        hint: `已存在：${duplicated.name}`,
      });
    }
    const workspace = {
      id: shortId('ws'),
      name: String(body.name || '').trim() || path.basename(resolvedPath) || resolvedPath,
      path: resolvedPath,
      defaultDeliveryPath: deliveryPath,
      createdAt: new Date().toISOString(),
    };
    await configStore.update({ workspaces: [...config.workspaces, workspace] });
    logger.info(`新增工作区：${workspace.name} → ${workspace.path}`);
    json(res, 200, { workspace: await describeWorkspace(workspace) });
  });

  router.patch('/api/workspaces/:id', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const config = configStore.get();
    const index = config.workspaces.findIndex((w) => w.id === ctx.params.id);
    if (index < 0) throw new AppError('工作区不存在', { code: 'WORKSPACE_NOT_FOUND', status: 404 });
    const current = config.workspaces[index];
    const next = { ...current };
    if (body.name !== undefined) next.name = String(body.name || '').trim() || current.name;
    if (body.path !== undefined) next.path = await validateDir(body.path, '工作区');
    if (body.defaultDeliveryPath !== undefined) {
      next.defaultDeliveryPath = body.defaultDeliveryPath
        ? await validateDir(body.defaultDeliveryPath, '默认交付区')
        : '';
    }
    const workspaces = config.workspaces.slice();
    workspaces[index] = next;
    await configStore.update({ workspaces });
    json(res, 200, { workspace: await describeWorkspace(next) });
  });

  router.delete('/api/workspaces/:id', async (req, res, ctx) => {
    const config = configStore.get();
    const target = config.workspaces.find((w) => w.id === ctx.params.id);
    if (!target) throw new AppError('工作区不存在', { code: 'WORKSPACE_NOT_FOUND', status: 404 });
    await configStore.update({ workspaces: config.workspaces.filter((w) => w.id !== ctx.params.id) });
    logger.info(`移除工作区：${target.name}`);
    json(res, 200, { ok: true });
  });
}
