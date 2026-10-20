/** 轻量 HTTP 框架：路由、静态文件、JSON 解析、SSE。只依赖 Node 内置模块。 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError, toAppError } from './errors.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({
      method,
      parts: pattern.split('/').filter(Boolean),
      pattern,
      handler,
    });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  put(pattern, handler) { return this.add('PUT', pattern, handler); }
  patch(pattern, handler) { return this.add('PATCH', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  match(method, pathname) {
    const target = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.parts.length !== target.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i += 1) {
        const part = route.parts[i];
        if (part.startsWith(':')) {
          params[part.slice(1)] = decodeURIComponent(target[i]);
        } else if (part !== target[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

export function json(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, err) {
  const appError = toAppError(err);
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  json(res, appError.status || 500, { error: appError.toJSON() });
}

export async function readJsonBody(req, { limit = 4 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new AppError('请求数据过大', { code: 'PAYLOAD_TOO_LARGE', status: 413 });
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('请求数据不是合法的 JSON', { code: 'BAD_JSON', status: 400 });
  }
}

/** SSE 通道：返回 { send, close } */
export function startSse(req, res, { onClose } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }
  }, 15000);
  heartbeat.unref?.();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { onClose?.(); } catch { /* ignore */ }
    try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  return {
    send(event, data) {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        cleanup();
      }
    },
    close: cleanup,
    get closed() { return closed; },
  };
}

/** 静态文件服务：只允许 web 目录内的文件，index.html 会注入前端 token */
export async function serveStatic(req, res, webRoot, pathname, { token } = {}) {
  let relative = decodeURIComponent(pathname);
  if (relative === '/' || relative === '') relative = '/index.html';
  const target = path.resolve(webRoot, `.${relative}`);
  if (!target.startsWith(path.resolve(webRoot))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  let stat = await fsp.stat(target).catch(() => null);
  if (!stat && !path.extname(target)) {
    const withHtml = `${target}.html`;
    stat = await fsp.stat(withHtml).catch(() => null);
    if (stat) return serveFile(req, res, withHtml, stat, token);
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  return serveFile(req, res, target, stat, token);
}

async function serveFile(req, res, filePath, stat, token) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isIndex = path.basename(filePath) === 'index.html';

  if (isIndex && token) {
    const html = await fsp.readFile(filePath, 'utf8');
    const body = html.replaceAll('%%APP_TOKEN%%', token);
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}
