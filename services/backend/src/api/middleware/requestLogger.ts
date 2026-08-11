import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "node:http";
import { PINO_REDACT_PATHS } from "../../core/security/redaction.js";
import { recordLatency } from "../../core/observability/latencyTracker.js";

/**
 * Structured request logging with config-level secret redaction
 * (docs/architecture/07-security-model.md §4) — `redact` strips matching
 * fields before pino serializes anything, so a provider key in
 * `req.body.apiKey`/`req.body.providerKeys` can never reach the log
 * stream via this path. Also feeds the per-route latency tracker that
 * backs `/health` (docs/architecture/08-deployment-architecture.md §9.1).
 */
export function requestLogger(logger: Logger) {
  const base = pinoHttp({
    logger,
    redact: { paths: PINO_REDACT_PATHS, censor: "[redacted]" },
    genReqId: () => crypto.randomUUID(),
    autoLogging: { ignore: (req: IncomingMessage) => req.url === "/healthz" },
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on("finish", () => {
      const routePath = req.route?.path ?? req.path ?? "unknown";
      recordLatency(`${req.method} ${routePath}`, Date.now() - start);
    });
    base(req, res, next);
  };
}
