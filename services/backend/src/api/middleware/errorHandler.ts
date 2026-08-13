import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { AppError } from "../errors.js";

export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, path: req.path }, "request failed");
      res.status(err.status).json({ error: { code: err.code, message: err.message, retryable: err.retryable } });
      return;
    }
    logger.error({ err, path: req.path }, "unhandled request error");
    res.status(500).json({ error: { code: "internal_error", message: "Internal server error", retryable: true } });
  };
}
