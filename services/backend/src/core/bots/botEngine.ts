import { Queue, QueueEvents, Worker, type Job } from "bullmq";
import type pg from "pg";
import type { AgentRegistry, BotRun, ModelRegistry, NotificationSender } from "@mdai/shared-types";
import { getRedisConnection } from "../../queue/connection.js";
import type { EventBus } from "../events/eventBus.js";
import type { ToolRegistryService } from "../mcp/toolRegistryService.js";
import type { BotRegistryService } from "./botRegistryService.js";
import { getBot, listEnabledBots, markBotRunning, recordBotRunOutcome } from "../../db/repositories/botRepo.js";
import { completeBotRun, createBotRun, listStuckBotRuns } from "../../db/repositories/botRunRepo.js";
import { processBotFindings } from "./pipeline.js";

export const BOT_ENGINE_QUEUE_NAME = "bot-engine";

// M5.17: Oracle target is 2 OCPU/12GB, single user — these are
// deliberately conservative fixed bounds, not per-deployment config, so a
// misbehaving or misconfigured bot can never consume the box.
export const MAX_CONCURRENT_BOT_RUNS = 2;
export const MAX_RUNS_PER_MINUTE = 20;
export const DEFAULT_RETRY_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 5000;
export const STUCK_RUN_SWEEP_MS = 60_000;

export interface BotEngineDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  botRegistry: BotRegistryService;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistryService;
  ownerId: string;
  notificationSender: NotificationSender;
}

function toBotRun(row: Awaited<ReturnType<typeof createBotRun>>): BotRun {
  return {
    id: row.id,
    botId: row.bot_id,
    startedAt: row.started_at.toISOString(),
    completedAt: row.finished_at?.toISOString(),
    durationMs: row.duration_ms ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    findingsCount: row.findings_count,
    resourceMetadata: row.resource_metadata,
  };
}

/**
 * M5.2: the shared-worker Bot Engine runtime, built directly on the
 * existing BullMQ infrastructure (`queue/connection.ts`, the same
 * createQueue/createWorker/scheduleRepeatable shape as
 * `eventsRetentionJob.ts`/`healthRollupJob.ts`) — one queue, one bounded
 * worker pool, jobs named after bot ids. This is deliberately NOT one
 * permanent process per bot: every bot's scheduled and run-once execution
 * flows through the same `MAX_CONCURRENT_BOT_RUNS`-bounded worker, so
 * adding a fifth or fiftieth bot never multiplies the process count.
 */
export class BotEngine {
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private queueEvents: QueueEvents | undefined;
  private sweepInterval: NodeJS.Timeout | undefined;

  constructor(private readonly deps: BotEngineDeps) {}

  /** M6: exposes the underlying queue for `/health`'s telemetry report (`core/observability/health.ts`) — undefined until `start()` has run. */
  getQueue(): Queue | undefined {
    return this.queue;
  }

  async start(): Promise<void> {
    this.queue = new Queue(BOT_ENGINE_QUEUE_NAME, { connection: getRedisConnection() });
    this.queueEvents = new QueueEvents(BOT_ENGINE_QUEUE_NAME, { connection: getRedisConnection() });
    await this.queueEvents.waitUntilReady();
    this.worker = new Worker(
      BOT_ENGINE_QUEUE_NAME,
      async (job: Job<{ botId: string }>) => this.executeBotRun(job.data.botId),
      {
        connection: getRedisConnection(),
        concurrency: MAX_CONCURRENT_BOT_RUNS,
        limiter: { max: MAX_RUNS_PER_MINUTE, duration: 60_000 },
      },
    );

    const bots = await listEnabledBots(this.deps.pool);
    for (const bot of bots) {
      await this.queue.add(
        bot.id,
        { botId: bot.id },
        {
          repeat: { pattern: bot.schedule_cron },
          jobId: `bot-repeat-${bot.id}`,
          attempts: DEFAULT_RETRY_ATTEMPTS,
          backoff: { type: "exponential", delay: BACKOFF_BASE_MS },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 50 },
        },
      );
    }

    // M5.2: a worker process crash mid-run leaves a `bot_runs` row stuck
    // `running` forever if nothing sweeps it — this periodic pass marks
    // any run that has outlived its own bot's timeout_ms as `timeout`, so
    // a health check never reports a bot as "still running" hours later.
    this.sweepInterval = setInterval(() => void this.sweepStuckRuns(), STUCK_RUN_SWEEP_MS);
  }

  async stop(): Promise<void> {
    if (this.sweepInterval) clearInterval(this.sweepInterval);
    await this.worker?.close();
    await this.queueEvents?.close();
    await this.queue?.close();
  }

  /** M5.16: Bot Fleet "run now" — enqueues a one-off job outside the bot's regular schedule, going through the identical bounded worker, and waits for it to finish so the caller gets a real result back. */
  async runNow(botId: string): Promise<BotRun> {
    if (!this.queue || !this.queueEvents) throw new Error("BotEngine not started");
    const job = await this.queue.add(
      `${botId}-manual-${Date.now()}`,
      { botId },
      { attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
    await job.waitUntilFinished(this.queueEvents);
    const row = await createBotRunLookupFallback(this.deps.pool, botId);
    return toBotRun(row);
  }

  private async sweepStuckRuns(): Promise<void> {
    const stuck = await listStuckBotRuns(this.deps.pool);
    for (const run of stuck) {
      await completeBotRun(this.deps.pool, run.id, {
        status: "timeout",
        errorCode: "timeout",
        error: `Run exceeded ${run.timeout_ms}ms and was marked timed out by the recovery sweep`,
        findingsCount: run.findings_count,
      });
      await recordBotRunOutcome(this.deps.pool, run.bot_id, { succeeded: false, health: "degraded", healthDetail: "run timed out" });
      await this.deps.eventBus.publish({
        sourceType: "bot",
        sourceId: run.bot_id,
        payload: { type: "bot.failed", botId: run.bot_id, botRunId: run.id, errorCode: "timeout", message: "Run timed out" },
      });
    }
  }

  private async executeBotRun(botId: string): Promise<void> {
    const descriptor = await getBot(this.deps.pool, botId);
    const implementation = this.deps.botRegistry.getImplementation(botId);
    if (!descriptor || !implementation) {
      throw new Error(`Bot ${botId} has no registered implementation to run`);
    }
    if (!descriptor.enabled || descriptor.status === "paused") return;

    await markBotRunning(this.deps.pool, botId);
    const runRow = await createBotRun(this.deps.pool, botId);
    await this.deps.eventBus.publish({
      sourceType: "bot",
      sourceId: botId,
      payload: { type: "bot.started", botId },
    });
    await this.deps.eventBus.publish({
      sourceType: "bot",
      sourceId: botId,
      payload: { type: "bot.run.started", botId, botRunId: runRow.id },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), descriptor.timeout_ms);
    const start = Date.now();

    try {
      const result = await implementation.run({
        botId,
        config: descriptor.config,
        signal: controller.signal,
        callSearchProvider: (query, maxResults) => callSearchProviderForBot(this.deps.pool, query, maxResults),
      });

      const findingsCount =
        result.status === "succeeded"
          ? await processBotFindings(
              { pool: this.deps.pool, eventBus: this.deps.eventBus, modelRegistry: this.deps.modelRegistry, agentRegistry: this.deps.agentRegistry, toolRegistry: this.deps.toolRegistry, ownerId: this.deps.ownerId, notificationSender: this.deps.notificationSender },
              botId,
              runRow.id,
              result.findings,
            )
          : 0;

      const durationMs = Date.now() - start;
      const status = result.status === "succeeded" ? "succeeded" : "failed";
      await completeBotRun(this.deps.pool, runRow.id, {
        status,
        error: result.error,
        findingsCount,
        resourceMetadata: result.resourceMetadata ?? {},
      });
      await recordBotRunOutcome(this.deps.pool, botId, {
        succeeded: status === "succeeded",
        health: status === "succeeded" ? "healthy" : "degraded",
        healthDetail: result.error,
      });
      await this.deps.eventBus.publish({
        sourceType: "bot",
        sourceId: botId,
        payload: { type: "bot.run.completed", botId, botRunId: runRow.id, status, durationMs, findingsCount },
      });
      if (status === "failed") {
        await this.deps.eventBus.publish({
          sourceType: "bot",
          sourceId: botId,
          severity: "warn",
          payload: { type: "bot.failed", botId, botRunId: runRow.id, errorCode: "run_failed", message: result.error ?? "Bot run failed" },
        });
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      const timedOut = controller.signal.aborted;
      const status = timedOut ? "timeout" : "failed";
      const message = err instanceof Error ? err.message : String(err);
      await completeBotRun(this.deps.pool, runRow.id, { status, errorCode: timedOut ? "timeout" : "bot_threw", error: message, findingsCount: 0 });
      await recordBotRunOutcome(this.deps.pool, botId, { succeeded: false, health: "degraded", healthDetail: message });
      await this.deps.eventBus.publish({
        sourceType: "bot",
        sourceId: botId,
        payload: { type: "bot.run.completed", botId, botRunId: runRow.id, status, durationMs, findingsCount: 0 },
      });
      await this.deps.eventBus.publish({
        sourceType: "bot",
        sourceId: botId,
        severity: "error",
        payload: { type: "bot.failed", botId, botRunId: runRow.id, errorCode: timedOut ? "timeout" : "bot_threw", message },
      });
      throw err; // let BullMQ apply its own attempts/backoff retry policy
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function createBotRunLookupFallback(pool: pg.Pool, botId: string) {
  const { listRecentBotRuns } = await import("../../db/repositories/botRunRepo.js");
  const [latest] = await listRecentBotRuns(pool, botId, 1);
  if (!latest) throw new Error(`No run recorded for bot ${botId} after run-now`);
  return latest;
}

/** Bots never receive a raw key directly — this resolves a search provider exactly like `web_search` does, just sourced from the opt-in background vault (M5.12a) instead of a live request's `toolKeys`, since a bot has no per-request caller to supply one. */
async function callSearchProviderForBot(pool: pg.Pool, query: string, maxResults = 5) {
  const [{ buildBackgroundToolKeys }, { decryptCredential }, { resolveSearchProvider }] = await Promise.all([
    import("../../db/repositories/backgroundCredentialRepo.js"),
    import("../security/backgroundKeyVault.js"),
    import("../mcp/tools/searchProviders/index.js"),
  ]);
  const toolKeys = await buildBackgroundToolKeys(pool, decryptCredential);
  const resolved = resolveSearchProvider(toolKeys);
  if (!resolved) return undefined;
  const controller = new AbortController();
  const results = await resolved.provider.search(resolved.apiKey, query, maxResults, controller.signal);
  return { results, provider: resolved.provider.id };
}
