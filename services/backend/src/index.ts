import { createServer } from "node:http";
import pino from "pino";
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

  const { applied } = await runMigrations(pool);
  logger.info({ appliedCount: applied.length }, "database migrations up to date");

  const owner = await ensureOwner(pool, "Owner");
  const activeSessions = await listActiveSessions(pool, owner.id);
  if (activeSessions.length === 0) {
    const code = await generatePairingCode(pool);
    logger.info(`\n\n  MD AI pairing code (single use, expires in ${env.MDAI_PAIRING_CODE_TTL_MINUTES}m): ${code}\n`);
  }

  const redis = getRedisConnection();
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

  const botEngine = new BotEngine({
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

  const eventsRetentionQueue = createEventsRetentionQueue();
  const eventsRetentionWorker = createEventsRetentionWorker(pool);
  await scheduleEventsRetentionRepeatable(eventsRetentionQueue);

  const healthRollupQueue = createHealthRollupQueue();
  const healthRollupWorker = createHealthRollupWorker(pool);
  await scheduleHealthRollupRepeatable(healthRollupQueue);

  // M9: discovery + benchmarking sweeps — see core/evolution/producer.ts.
  const evolutionSweepQueue = createEvolutionSweepQueue();
  const evolutionSweepWorker = createEvolutionSweepWorker(pool, eventBus, modelRegistry, memoryEngine);
  await scheduleEvolutionSweepRepeatable(evolutionSweepQueue);

  // M6: the Bot Engine's own queue joins /health's telemetry (bot-engine
  // job counts weren't visible there before this milestone).
  const botEngineQueue = botEngine.getQueue();

  const app = createApp({
    pool,
    redis,
    queues: botEngineQueue
      ? [eventsRetentionQueue, healthRollupQueue, evolutionSweepQueue, botEngineQueue]
      : [eventsRetentionQueue, healthRollupQueue, evolutionSweepQueue],
    eventBus,
    modelRegistry,
    agentRegistry,
    memoryEngine,
    toolRegistry,
    botRegistry,
    botEngine,
    logger,
  });
  const server = createServer(app);
  attachChatGateway(server, pool);
  attachEventsGateway(server, pool, eventBus);

  server.listen(env.PORT, () => {
    logger.info(`MD AI backend listening on :${env.PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down`);
    server.close();
    await botEngine.stop();
    await eventsRetentionWorker.close();
    await eventsRetentionQueue.close();
    await healthRollupWorker.close();
    await healthRollupQueue.close();
    await evolutionSweepWorker.close();
    await evolutionSweepQueue.close();
    await closeRedisConnection();
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
