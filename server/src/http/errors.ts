/** Public, intentional errors. Unexpected exceptions never expose stacks or credentials. */
import type { ErrorRequestHandler } from "express";
import multer from "multer";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) {
    res
      .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({
        status: "error",
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "录音文件不能超过 32MB"
            : "音频上传格式错误，请只上传一个 audio 文件",
      });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ status: 'error', error: '请求 JSON 格式错误' });
    return;
  }
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    res.status(413).json({ status: 'error', error: '请求内容过大' });
    return;
  }
  res
    .status(error instanceof HttpError ? error.status : 500)
    .json({
      status: "error",
      error: error instanceof HttpError ? error.message : "服务处理失败，请稍后重试",
    });
};
