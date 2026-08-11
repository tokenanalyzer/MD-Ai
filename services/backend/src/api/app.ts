import express, { type Express } from "express";
import type pg from "pg";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { Logger } from "pino";
import type { ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../core/events/eventBus.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.js";
import { providersRouter } from "./routes/providers.js";
import { modelsRouter } from "./routes/models.js";
import { conversationsRouter } from "./routes/conversations.js";
import { tasksRouter } from "./routes/tasks.js";
import { healthRouter, healthzRouter } from "./routes/health.js";

export interface AppDeps {
  pool: pg.Pool;
  redis: Redis;
  queues: Queue[];
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  logger: Logger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(requestLogger(deps.logger));

  app.use("/healthz", healthzRouter());
  app.use("/health", healthRouter(deps.pool, deps.redis, deps.queues));
  app.use("/auth", authRouter(deps.pool));
  app.use("/providers", providersRouter(deps.pool, deps.modelRegistry));
  app.use("/models", modelsRouter(deps.pool, deps.modelRegistry));
  app.use("/conversations", conversationsRouter(deps.pool, deps.eventBus, deps.modelRegistry));
  app.use("/tasks", tasksRouter(deps.pool));

  app.use(errorHandler(deps.logger));
  return app;
}
