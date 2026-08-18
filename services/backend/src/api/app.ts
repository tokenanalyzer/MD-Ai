import express, { type Express } from "express";
import type pg from "pg";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { Logger } from "pino";
import type { AgentRegistry, BotRegistry, MemoryEngine, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../core/events/eventBus.js";
import type { ToolRegistryService } from "../core/mcp/toolRegistryService.js";
import type { BotEngine } from "../core/bots/botEngine.js";
import type { AutomationEngine } from "../core/automations/automationEngine.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.js";
import { providersRouter } from "./routes/providers.js";
import { searchProvidersRouter } from "./routes/searchProviders.js";
import { modelsRouter } from "./routes/models.js";
import { conversationsRouter } from "./routes/conversations.js";
import { tasksRouter } from "./routes/tasks.js";
import { healthRouter, healthzRouter } from "./routes/health.js";
import { memoryRouter } from "./routes/memory.js";
import { agentsRouter } from "./routes/agents.js";
import { toolsRouter } from "./routes/tools.js";
import { botsRouter } from "./routes/bots.js";
import { notificationsRouter } from "./routes/notifications.js";
import { userTopicsRouter } from "./routes/userTopics.js";
import { backgroundCredentialsRouter } from "./routes/backgroundCredentials.js";
import { eventsRouter } from "./routes/events.js";
import { evolutionRouter } from "./routes/evolution.js";
import { automationsRouter } from "./routes/automations.js";
import { webhooksRouter } from "./routes/webhooks.js";

export interface AppDeps {
  pool: pg.Pool;
  // Absent exactly when REDIS_URL isn't configured — see index.ts. Routes
  // that need these must degrade cleanly rather than assume presence.
  redis: Redis | undefined;
  queues: Queue[];
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
  memoryEngine: MemoryEngine;
  toolRegistry: ToolRegistryService;
  botRegistry: BotRegistry;
  botEngine: BotEngine | undefined;
  automationEngine: AutomationEngine | undefined;
  logger: Logger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // M10: `verify` stashes the exact bytes received so the signed automation
  // webhook route can compute its HMAC over what was actually sent, not a
  // re-serialization of the parsed body (which could differ in key order/
  // whitespace and break the signature check).
  app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(requestLogger(deps.logger));

  // M7: lets `pnpm web` (a real browser, unlike React Native's fetch which
  // never enforces CORS) talk to this backend at all — every route below
  // is either Bearer-token-gated or (M10's one deliberate exception,
  // `/webhooks/automations/:slug`) HMAC-signature-gated
  // (docs/architecture/07-security-model.md §2), so an open origin carries
  // no ambient-credential/CSRF risk the way it would for a
  // cookie-authenticated API — and CORS itself is moot for that route
  // anyway, since its real caller (e.g. n8n) is a server, not a browser.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use("/healthz", healthzRouter());
  app.use("/health", healthRouter(deps.pool, deps.redis, deps.queues));
  app.use("/auth", authRouter(deps.pool));
  app.use("/providers", providersRouter(deps.pool, deps.modelRegistry));
  app.use("/search-providers", searchProvidersRouter(deps.pool));
  app.use("/models", modelsRouter(deps.pool, deps.modelRegistry));
  app.use("/agents", agentsRouter(deps.pool, deps.agentRegistry));
  app.use("/memory", memoryRouter(deps.pool, deps.memoryEngine));
  app.use("/tools", toolsRouter(deps.pool, deps.toolRegistry, deps.eventBus));
  app.use("/bots", botsRouter(deps.pool, deps.botRegistry, deps.botEngine));
  app.use("/notifications", notificationsRouter(deps.pool));
  app.use("/user-topics", userTopicsRouter(deps.pool));
  app.use("/background-credentials", backgroundCredentialsRouter(deps.pool));
  app.use("/events", eventsRouter(deps.pool));
  app.use("/evolution", evolutionRouter(deps.pool, deps.eventBus, deps.modelRegistry, deps.memoryEngine));
  app.use("/automations", automationsRouter(deps.pool, deps.automationEngine));
  app.use("/webhooks", webhooksRouter(deps.pool, deps.automationEngine));
  app.use(
    "/conversations",
    conversationsRouter(deps.pool, deps.eventBus, deps.modelRegistry, deps.agentRegistry, deps.toolRegistry),
  );
  app.use("/tasks", tasksRouter(deps.pool));

  app.use(errorHandler(deps.logger));
  return app;
}
