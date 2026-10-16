import { randomBytes } from 'node:crypto';
import { AppError, appError } from './errors.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** 每个请求一个 requestId：沿用网关传入的合法 X-Request-Id，否则生成；写入响应头便于排查。 */
export function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && REQUEST_ID.test(incoming) ? incoming : `req_${randomBytes(9).toString('base64url')}`;
    res.set('X-Request-Id', req.id);
    next();
  };
}

/** Express 4 不会捕获 async 异常，所有 async 路由用它包一层。 */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFound() {
  return (req, res, next) => next(appError('NOT_FOUND', '接口不存在'));
}

/** 统一错误出口：只把 AppError 的信息给用户，其他异常记日志后返回 INTERNAL。 */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let error = err;
    if (!(error instanceof AppError)) {
      if (err?.type === 'entity.parse.failed') error = appError('VALIDATION_FAILED', '请求格式不正确');
      else if (err?.type === 'entity.too.large') error = appError('VALIDATION_FAILED', '请求内容太大');
      else {
        logger.error('unhandled_error', { requestId: req.id, method: req.method, path: req.path, err });
        error = appError('INTERNAL');
      }
    } else if (error.status >= 500) {
      logger.error('app_error', { requestId: req.id, method: req.method, path: req.path, code: error.code, err });
    }
    if (res.headersSent) return;
    const body = { code: error.code, message: error.message, requestId: req.id };
    if (error.details !== undefined) body.details = error.details;
    res.status(error.status).json(body);
  };
}
