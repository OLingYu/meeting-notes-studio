/**
 * 统一错误类型。
 * 所有对外部模型/文件系统的失败都归一化成 AppError，便于界面展示中文提示与 requestId。
 */

export class AppError extends Error {
  constructor(message, options = {}) {
    super(message || '未知错误');
    this.name = 'AppError';
    this.code = options.code || 'APP_ERROR';
    this.hint = options.hint || '';
    this.status = options.status || 400;
    this.provider = options.provider || '';
    this.requestId = options.requestId || '';
    this.detail = options.detail || '';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      status: this.status,
      provider: this.provider,
      requestId: this.requestId,
      detail: this.detail,
    };
  }
}

/** SDK/网络层抛出的原始错误 → AppError */
export function toAppError(err, options = {}) {
  if (err instanceof AppError) return err;
  if (isAbortError(err)) {
    return new AppError('任务已取消', { code: 'ABORTED', status: 499, hint: '这是你手动取消的操作' });
  }
  const message = err?.message || String(err);
  return new AppError(message, {
    code: options.code || 'UNEXPECTED',
    status: options.status || 500,
    hint: options.hint || '如果反复出现，请把这条信息反馈给开发者',
    provider: options.provider || '',
    detail: options.detail || '',
  });
}

export function isAbortError(err) {
  if (!err) return false;
  if (err.code === 'ABORTED') return true;
  return err.name === 'AbortError' || err.code === 'ABORT_ERR';
}

/** 把错误转成任务里存的短信息 */
export function errorPayload(err) {
  const e = toAppError(err);
  return {
    code: e.code,
    message: e.message,
    hint: e.hint,
    provider: e.provider,
    requestId: e.requestId,
    detail: e.detail,
  };
}
