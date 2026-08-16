import { createServer } from "node:http";
import type { Express } from "express";
import pino from "pino";
import type { Redis } from "ioredis";
import type { Queue, Worker } from "bullmq";
import { installSsrfSafeDispatcher } from "./core/security/ssrfSafeDispatcher.js";
import { loadEnv } from "./config/env.js";
import { getPool, closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { ensureOwner } from "./db/repositories/ownerRepo.js";
import { listActiveSessions } from "./db/repositories/deviceSessionRepo.js";
import { generatePairingCode } from "./core/security/pairing.js";
import { EventBus } from "./core/events/eventBus.js";
import { ModelRegistryService } from "./core/registry/modelRegistryService.js";
import { AgentRegistryService } from "./core/agents/agentRegistryService.js";
import { MemoryEngineService } from "./core/memory/memoryEngine.js";
import { ToolRegistryService } from "./core/mcp/toolRegistryService.js";
import { createResearchAgent } from "./core/agents/research/researchAgent.js";
import { createReviewerAgent } from "./core/agents/reviewer/reviewerAgent.js";
import { createMasterAgent } from "./core/agents/master/masterAgent.js";
import { createSpecialistAgents } from "./core/agents/specialist/specialists.js";
import { createGuardianAgent } from "./core/agents/guardian/guardianAgent.js";
import { webSearchTool } from "./core/mcp/tools/webSearchTool.js";
import { urlReaderTool } from "./core/mcp/tools/urlReaderTool.js";
import { fileReaderTool } from "./core/mcp/tools/fileReaderTool.js";
import { pdfReaderTool } from "./core/mcp/tools/pdfReaderTool.js";
import { calculatorTool } from "./core/mcp/tools/calculatorTool.js";
import { timeDateTool } from "./core/mcp/tools/timeDateTool.js";
import { httpGetTool } from "./core/mcp/tools/httpGetTool.js";
import { BotRegistryService } from "./core/bots/botRegistryService.js";
import { BotEngine } from "./core/bots/botEngine.js";
import { aiModelReleaseMonitor } from "./core/bots/aiModelReleaseMonitor.js";
import { newsMonitor } from "./core/bots/newsMonitor.js";
import { createUserTopicMonitor } from "./core/bots/userTopicMonitor.js";
import { createSystemHealthMonitor } from "./core/bots/systemHealthMonitor.js";
import { marketScanner } from "./core/bots/marketScanner.js";
import { liquidityMonitor } from "./core/bots/liquidityMonitor.js";
import { volumeAnomalyMonitor } from "./core/bots/volumeAnomalyMonitor.js";
import { socialTrendMonitor } from "./core/bots/socialTrendMonitor.js";
import { businessOpportunityMonitor } from "./core/bots/businessOpportunityMonitor.js";
import { AutomationEngine } from "./core/automations/automationEngine.js";
import { expoPushSender } from "./core/notifications/expoPushSender.js";
import { getRedisConnection, closeRedisConnection } from "./queue/connection.js";
import {
  createEventsRetentionQueue,
  createEventsRetentionWorker,
  scheduleEventsRetentionRepeatable,
} from "./queue/eventsRetentionJob.js";
import {
  createHealthRollupQueue,
  createHealthRollupWorker,
  scheduleHealthRollupRepeatable,
} from "./queue/healthRollupJob.js";
import {
  createEvolutionSweepQueue,
  createEvolutionSweepWorker,
  scheduleEvolutionSweepRepeatable,
} from "./queue/evolutionSweepJob.js";
import { createApp } from "./api/app.js";
import { attachChatGateway } from "./api/ws/chatGateway.js";
import { attachEventsGateway } from "./api/ws/eventsGateway.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main(): Promise<void> {
  // M5.0: every outbound fetch (provider calls and tool calls alike) goes
  // through the DNS-rebinding-safe dispatcher from process start — see
  // core/security/ssrfSafeDispatcher.ts.
  installSsrfSafeDispatcher();

  const env = loadEnv();
  const pool = getPool();

  // Cloud Run (and any container platform with a startup probe) requires
  // the port to be listening almost immediately — migrations, owner/
  // session bootstrap, and Redis-dependent engine startup below can
  // together take long enough to blow past that deadline. So the HTTP
  // listener is opened first with a placeholder handler; `app` stays
  // undefined (every request gets a 503) until `bootstrap()` finishes and
  // assigns the real Express app — the port itself is already accepting
  // connections the whole time. State that `shutdown()` needs to clean up
  // is declared here so both `bootstrap()` and `shutdown()` close over the
  // same variables.
  let app: Express | undefined;
  let redis: Redis | undefined;
  let botEngine: BotEngine | undefined;
  let automationEngine: AutomationEngine | undefined;
  let eventsRetentionQueue: Queue | undefined;
  let eventsRetentionWorker: Worker | undefined;
  let healthRollupQueue: Queue | undefined;
  let healthRollupWorker: Worker | undefined;
  let evolutionSweepQueue: Queue | undefined;
  let evolutionSweepWorker: Worker | undefined;

  const server = createServer((req, res) => {
    if (app) {
      app(req, res);
      return;
    }
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { code: "starting_up", message: "MD AI backend is still starting up", retryable: true } }));
  });

  // Guards against ever re-running bootstrap (and therefore ever starting
  // the Bot Engine, Automation Engine, or maintenance workers twice) —
  // `server.listen`'s callback only fires once per successful bind, but
  // this makes that guarantee explicit rather than implicit.
  let bootstrapped = false;

  async function bootstrap(): Promise<void> {
    if (bootstrapped) return;
    bootstrapped = true;

    const { applied } = await runMigrations(pool);
    logger.info({ appliedCount: applied.length }, "database migrations up to date");

    const owner = await ensureOwner(pool, "Owner");
    const activeSessions = await listActiveSessions(pool, owner.id);
    if (activeSessions.length === 0) {
      const code = await generatePairingCode(pool);
      logger.info(`\n\n  MD AI pairing code (single use, expires in ${env.MDAI_PAIRING_CODE_TTL_MINUTES}m): ${code}\n`);
    }

    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const agentRegistry = new AgentRegistryService(pool);
    const memoryEngine = new MemoryEngineService(pool);
    const toolRegistry = new ToolRegistryService(pool);
    const botRegistry = new BotRegistryService(pool);

    // M3 roster: Master, Research, Reviewer — see docs/architecture/
    // 04-agent-interfaces.md for why the full specialist-agent ecosystem
    // waits for a later milestone. Registration order doesn't matter: the
    // Agent Registry's DB-backed `agent_delegation_edges` rows, not
    // in-process load order, are what authorize Master to delegate to the
    // other two.
    agentRegistry.register(createResearchAgent());
    agentRegistry.register(createReviewerAgent());
    agentRegistry.register(createMasterAgent({ agentRegistry, memoryEngine }));

    // M8 roster: six domain specialists (each the same real tool-using
    // pipeline as Research, parameterized by domain focus — see
    // core/agents/specialist/specialistAgentFactory.ts) plus Guardian.
    // Selectable purely via `agent_delegation_edges` data (migration 0021),
    // no change to Master's capability-based delegation logic.
    for (const specialist of createSpecialistAgents()) {
      agentRegistry.register(specialist);
    }
    agentRegistry.register(createGuardianAgent());

    // M4.3 first safe tool set — see docs/architecture/11-mcp-tools.md.
    // Which agent may actually call which tool is `agent_tool_grants` data
    // (migration 0019), not this registration order.
    toolRegistry.register(webSearchTool);
    toolRegistry.register(urlReaderTool);
    toolRegistry.register(fileReaderTool);
    toolRegistry.register(pdfReaderTool);
    toolRegistry.register(calculatorTool);
    toolRegistry.register(timeDateTool);
    toolRegistry.register(httpGetTool);

    // M10: optional external MCP tool sources (OpenClaw is the first real
    // candidate — see core/mcp/toolRegistryService.ts's connectServer).
    // Never blocks or crashes boot: an unreachable/misconfigured server is
    // logged and skipped, same "optional integration point" posture as n8n.
    const externalMcpServers = env.MDAI_EXTERNAL_MCP_SERVERS?.split(",").map((u) => u.trim()).filter(Boolean) ?? [];
    for (const serverUrl of externalMcpServers) {
      try {
        const connected = await toolRegistry.connectServer(serverUrl);
        logger.info({ serverUrl, toolCount: connected.length }, "connected external MCP server");
      } catch (err) {
        logger.warn({ serverUrl, err }, "failed to connect external MCP server — continuing without it");
      }
    }

    // Redis/BullMQ (Bot Engine, Automation Engine, and the 3 maintenance
    // workers) is entirely optional — REDIS_URL absent means none of this
    // block runs and no Redis connection is attempted at all (getRedisConnection()
    // itself would throw if called without it configured). Everything above
    // this point (auth/pairing, agents, tools, chat) has no Redis dependency
    // and is unaffected either way — see docs/architecture note in env.ts.
    let queues: Queue[] = [];

    if (env.REDIS_URL) {
      redis = getRedisConnection();

      // M5.7-M5.11: exactly four bots, no hardcoded scheduler list — the Bot
      // Engine only ever dispatches to what's registered here *and* marked
      // `enabled` in the DB (migration 0020's seed rows). Explicitly NOT
      // crypto/stock trading bots or exchange execution — see
      // docs/architecture/12-bot-engine.md §1.
      botRegistry.register(aiModelReleaseMonitor);
      botRegistry.register(newsMonitor);
      botRegistry.register(createUserTopicMonitor(pool));
      botRegistry.register(createSystemHealthMonitor(pool, redis));

      // M8 remaining bots — same deterministic SearchProvider pattern as News
      // Monitor (M5.9); see docs/architecture/09-roadmap.md M8.
      botRegistry.register(marketScanner);
      botRegistry.register(liquidityMonitor);
      botRegistry.register(volumeAnomalyMonitor);
      botRegistry.register(socialTrendMonitor);
      botRegistry.register(businessOpportunityMonitor);

      botEngine = new BotEngine({
        pool,
        eventBus,
        botRegistry,
        modelRegistry,
        agentRegistry,
        toolRegistry,
        ownerId: owner.id,
        notificationSender: expoPushSender,
      });
      await botEngine.start();

      // M10: n8n/agent-task/notification automations — see core/automations/automationEngine.ts.
      automationEngine = new AutomationEngine({
        pool,
        eventBus,
        modelRegistry,
        agentRegistry,
        toolRegistry,
        ownerId: owner.id,
        notificationSender: expoPushSender,
      });
      await automationEngine.start();

      eventsRetentionQueue = createEventsRetentionQueue();
      eventsRetentionWorker = createEventsRetentionWorker(pool);
      await scheduleEventsRetentionRepeatable(eventsRetentionQueue);

      healthRollupQueue = createHealthRollupQueue();
      healthRollupWorker = createHealthRollupWorker(pool);
      await scheduleHealthRollupRepeatable(healthRollupQueue);

      // M9: discovery + benchmarking sweeps — see core/evolution/producer.ts.
      evolutionSweepQueue = createEvolutionSweepQueue();
      evolutionSweepWorker = createEvolutionSweepWorker(pool, eventBus, modelRegistry, memoryEngine);
      await scheduleEvolutionSweepRepeatable(evolutionSweepQueue);

      // M6: the Bot Engine's own queue joins /health's telemetry (bot-engine
      // job counts weren't visible there before this milestone).
      const botEngineQueue = botEngine.getQueue();
      const automationEngineQueue = automationEngine.getQueue();

      const baseQueues = [eventsRetentionQueue, healthRollupQueue, evolutionSweepQueue];
      queues = [botEngineQueue, automationEngineQueue].reduce((acc, q) => (q ? [...acc, q] : acc), baseQueues);
    } else {
      logger.warn(
        "REDIS_URL is not configured — Bot Engine, Automation Engine, and maintenance workers are disabled. Core chat, pairing, and provider functionality are unaffected.",
      );
    }

    app = createApp({
      pool,
      redis,
      queues,
      eventBus,
      modelRegistry,
      agentRegistry,
      memoryEngine,
      toolRegistry,
      botRegistry,
      botEngine,
      automationEngine,
      logger,
    });
    attachChatGateway(server, pool);
    attachEventsGateway(server, pool, eventBus);

    logger.info("MD AI backend bootstrap complete");
  }

  server.listen(env.PORT, () => {
    logger.info(`MD AI backend listening on :${env.PORT} (bootstrap running in background)`);
    // Deliberately not awaited: the HTTP listener must stay responsive to
    // Cloud Run's startup probe regardless of how long migrations/owner
    // bootstrap/Redis engine startup take. A bootstrap failure is a
    // clearly-logged degraded state, not a process-killing one — see the
    // catch below.
    bootstrap().catch((err) => {
      logger.error({ err }, "fatal bootstrap error — HTTP server is still listening, but the backend did not finish initializing");
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    server.close();
    await botEngine?.stop();
    await automationEngine?.stop();
    await eventsRetentionWorker?.close();
    await eventsRetentionQueue?.close();
    await healthRollupWorker?.close();
    await healthRollupQueue?.close();
    await evolutionSweepWorker?.close();
    await evolutionSweepQueue?.close();
    if (redis) await closeRedisConnection();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
