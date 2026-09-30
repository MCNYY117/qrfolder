/**
 * 带 HTTP 状态码的错误。
 *
 * 约定：内容面对「不存在」与「无权限」一律返回 404 而非 403 ——
 * 403 等于告诉对方「这个文件存在，只是不给你看」，是一处信息泄露。
 */

export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.status = status;
  }
}

export const notFound = (message?: string): HttpError => new HttpError(404, message);
export const forbidden = (message?: string): HttpError => new HttpError(403, message);
export const badRequest = (message?: string): HttpError => new HttpError(400, message);
export const unauthorized = (message?: string): HttpError => new HttpError(401, message);
export const tooManyRequests = (message?: string): HttpError => new HttpError(429, message);
export const serviceUnavailable = (message?: string): HttpError => new HttpError(503, message);
export const unsupportedMedia = (message?: string): HttpError => new HttpError(415, message);
export const payloadTooLarge = (message?: string): HttpError => new HttpError(413, message);

/** 该状态码是否应该向访客展示通用错误页 */
export function isClientVisible(status: number): boolean {
  return status >= 400 && status < 600;
}
