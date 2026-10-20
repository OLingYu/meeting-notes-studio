/**
 * 应用入口：装配配置、任务管理器、接口路由与静态资源，探测端口后启动。
 * 也可以被测试直接 import 使用（createApp）。
 */

import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDir } from './store.mjs';
import { createLogger } from './log.mjs';
import { createConfigStore } from './config.mjs';
import { Router, json, sendError, serveStatic } from './http.mjs';
import { AppError } from './errors.mjs';
import { TaskManager } from './pipeline/runner.mjs';
import { registerConfigRoutes } from './api/config.mjs';
import { registerFsRoutes } from './api/fs.mjs';
import { registerWorkspaceRoutes } from './api/workspaces.mjs';
import { registerTaskRoutes } from './api/tasks.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB_ROOT = path.join(ROOT, 'web');

function openBrowser(url) {
  try {
    const platform = process.platform;
    const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* 打不开浏览器就靠控制台地址 */ }
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(server, desiredPort, host, logger) {
  const candidates = [desiredPort];
  for (let i = 1; i <= 20; i += 1) candidates.push(desiredPort + i);
  for (const port of candidates) {
    try {
      const actual = await listenOnce(server, port, host);
      if (port !== desiredPort) logger?.warn?.(`端口 ${desiredPort} 被占用，已改用 ${port}`);
      return actual;
    } catch (err) {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') continue;
      throw err;
    }
  }
  throw new AppError(`端口 ${desiredPort} 起的 21 个端口都被占用了`, {
    code: 'NO_PORT',
    status: 500,
    hint: '在设置里换一个端口，或关掉占用端口的程序',
  });
}

export async function createApp({
  dataDir = path.join(ROOT, 'data'),
  port = null,
  host = '127.0.0.1',
  autoOpenBrowser = false,
  logger: providedLogger = null,
  pickDirectoryRunner = null,
} = {}) {
  await ensureDir(dataDir);
  const logger = providedLogger || createLogger({ dataDir });
  const configStore = await createConfigStore({ dataDir, logger });
  const manager = new TaskManager({ configStore, dataDir, logger });
  await manager.init();

  const router = new Router();
  const runtime = { port: 0 };
  const shared = { configStore, manager, logger, dataDir, runtime, pickDirectoryRunner };

  registerConfigRoutes(router, shared);
  registerFsRoutes(router);
  registerWorkspaceRoutes(router, shared);
  registerTaskRoutes(router, shared);

  const token = crypto.randomBytes(16).toString('hex');
  let actualPort = 0;
  let allowedOrigins = new Set();

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    const pathname = url.pathname;

    try {
      if (pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && allowedOrigins.size && !allowedOrigins.has(origin)) {
          throw new AppError('请求来源不被允许', { code: 'BAD_ORIGIN', status: 403 });
        }
        const headerToken = req.headers['x-app-token'];
        const queryToken = url.searchParams.get('token');
        if (headerToken !== token && queryToken !== token) {
          throw new AppError('缺少访问凭证，请从启动窗口打印的地址进入', {
            code: 'UNAUTHORIZED',
            status: 401,
            hint: '刷新页面（F5）后重试',
          });
        }

        const matched = router.match(req.method || 'GET', pathname);
        if (!matched) {
          throw new AppError(`接口不存在：${req.method} ${pathname}`, { code: 'NOT_FOUND', status: 404 });
        }
        await matched.handler(req, res, {
          ...shared,
          params: matched.params,
          url,
          token,
        });
        return;
      }

      await serveStatic(req, res, WEB_ROOT, pathname, { token });
    } catch (err) {
      if (!(err instanceof AppError)) {
        logger.error(`请求处理失败：${req.method} ${pathname} → ${err?.stack || err}`);
      }
      if (pathname.startsWith('/api/')) {
        sendError(res, err);
      } else if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`服务器错误：${err?.message || err}`);
      }
    } finally {
      if (process.env.DEBUG) {
        logger.debug(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  const desiredPort = port ?? configStore.get().server.port ?? 8787;
  actualPort = await listenWithFallback(server, Number(desiredPort), host, logger);
  runtime.port = actualPort;
  allowedOrigins = new Set([
    `http://127.0.0.1:${actualPort}`,
    `http://localhost:${actualPort}`,
    `http://[::1]:${actualPort}`,
  ]);

  const url = `http://127.0.0.1:${actualPort}/`;

  if (autoOpenBrowser) openBrowser(url);

  return {
    server,
    port: actualPort,
    url,
    token,
    dataDir,
    configStore,
    manager,
    logger,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const noOpen = process.argv.includes('--no-open');
  const preLogger = createLogger({ dataDir: path.join(ROOT, 'data') });
  let app;
  try {
    app = await createApp({
      dataDir: path.join(ROOT, 'data'),
      autoOpenBrowser: !noOpen,
      logger: preLogger,
    });
  } catch (err) {
    console.error(`\n启动失败：${err?.message || err}\n`);
    if (err?.hint) console.error(`建议：${err.hint}\n`);
    process.exitCode = 1;
    return;
  }

  const config = app.configStore.get();
  console.log('');
  console.log('================================================');
  console.log('  会议纪要工坊 Meeting Notes Studio 已启动');
  console.log(`  请在浏览器打开： ${app.url}`);
  console.log(`  监听地址： 127.0.0.1:${app.port}（仅本机可访问）`);
  console.log(`  数据目录： ${app.dataDir}`);
  console.log(`  配置文件： ${path.join(app.dataDir, 'config.json')}`);
  console.log('  关闭这个窗口或按 Ctrl+C 即可停止');
  console.log('================================================');
  console.log('');

  if (!config.server.autoOpenBrowser && !noOpen) {
    console.log('（提示：自动打开浏览器已在设置里关闭，请手动访问上面的地址）');
  }

  const shutdown = async () => {
    console.log('\n正在停止服务…');
    try {
      app.manager.controllers?.forEach?.((controller) => controller.abort());
    } catch { /* ignore */ }
    try {
      await app.close();
    } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`启动异常：${err?.stack || err}`);
    process.exitCode = 1;
  });
}
