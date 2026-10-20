/** 日志：控制台 + 任务级 log.jsonl，同时把日志推给 SSE 订阅者。 */

import { appendLine } from './store.mjs';
import { formatClock } from './lib/time.mjs';

const LEVEL_LABEL = { info: '信息', warn: '注意', error: '错误', debug: '调试' };

export function createLogger({ dataDir }) {
  const listeners = new Set();

  function emit(entry) {
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch { /* 订阅者异常不影响主流程 */ }
    }
  }

  function write(level, message, meta) {
    const text = typeof message === 'string' ? message : String(message);
    const line = `[${formatClock()}] ${LEVEL_LABEL[level] || level} ${text}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    let entry = { at: Date.now(), level, message: text, ...(meta || {}) };

    if (meta?.taskId) {
      const file = `${dataDir}/tasks/${meta.taskId}/log.jsonl`;
      entry = { ...entry, formatted: line };
      appendLine(file, JSON.stringify(entry)).catch(() => {});
    }
    emit(entry);
    return entry;
  }

  const logger = {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    debug: (message, meta) => {
      if (process.env.DEBUG) write('debug', message, meta);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    task(taskId) {
      return {
        info: (message) => write('info', message, { taskId }),
        warn: (message) => write('warn', message, { taskId }),
        error: (message) => write('error', message, { taskId }),
        debug: (message) => write('debug', message, { taskId }),
      };
    },
  };

  return logger;
}
