import { Queue, QueueEvents, Worker, type Job } from "bullmq";
import type pg from "pg";
import type { Logger } from "pino";
import type { AgentRegistry, ModelRegistry, NotificationSender } from "@mdai/shared-types";
import { getRedisConnection } from "../../queue/connection.js";
import type { EventBus } from "../events/eventBus.js";
import type { EventRow } from "../../db/repositories/eventRepo.js";
import type { ToolRegistryService } from "../mcp/toolRegistryService.js";
import {
  getAutomation,
  listEnabledAutomations,
  markAutomationRan,
  type AutomationRow,
  type AutomationTriggerType,
} from "../../db/repositories/automationRepo.js";
import {
  completeAutomationRun,
  createAutomationRun,
  listStuckAutomationRuns,
  type AutomationRunRow,
} from "../../db/repositories/automationRunRepo.js";
import { dispatchAgentTask } from "./dispatchAgentTask.js";
import { dispatchN8nWorkflow } from "./dispatchN8nWorkflow.js";
import { dispatchNotification } from "./dispatchNotification.js";

export const AUTOMATION_ENGINE_QUEUE_NAME = "automation-engine";

// Same "fixed, conservative bound" reasoning as the Bot Engine (M5.17) —
// a single-user Oracle target box, not per-deployment config.
export const MAX_CONCURRENT_AUTOMATION_RUNS = 2;
export const DEFAULT_RETRY_ATTEMPTS = 1; // automations are not idempotent by default (n8n_workflow, notification) — no silent retry-and-double-fire
export const STUCK_RUN_SWEEP_MS = 60_000;

export interface AutomationEngineDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistryService;
  ownerId: string;
  notificationSender: NotificationSender;
  logger: Logger;
}

/**
 * M10: the shared-worker Automation Engine, built on the identical BullMQ
 * pattern as `BotEngine` (M5.2) — one queue, one bounded worker pool.
 * `trigger_type = 'schedule'` automations get a BullMQ repeatable job per
 * automation, exactly like a bot's `schedule_cron`. `trigger_type =
 * 'event'` automations are driven by `EventBus.subscribe`, not a second
 * polling mechanism. `trigger_type = 'webhook'`/`'manual'` never get a
 * repeatable schedule — they're only ever reached via `runNow`, called
 * from the signed webhook route or `POST /automations/:id/run`.
 *
 * Safety-critical property: every `action_type` funnels into a
 * pre-existing, already-gated execution path (`dispatchAgentTask` reuses
 * Master's own entry point, `dispatchN8nWorkflow` is a single outbound
 * `safeFetch`, `dispatchNotification` reuses the M5.13 notification
 * pipeline) — there is no fourth, automation-specific way to reach a
 * tool, a capability, or a state mutation, so an externally-triggered
 * automation (webhook) can never reach anything a normal chat message
 * couldn't, and Guardian's tool-approval gate (M8) applies identically
 * either way.
 */
export class AutomationEngine {
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private queueEvents: QueueEvents | undefined;
  private sweepInterval: NodeJS.Timeout | undefined;
  private unsubscribeEvents: (() => void) | undefined;

  constructor(private readonly deps: AutomationEngineDeps) {}

  getQueue(): Queue | undefined {
    return this.queue;
  }

  async start(): Promise<void> {
    this.queue = new Queue(AUTOMATION_ENGINE_QUEUE_NAME, { connection: getRedisConnection() });
    this.queueEvents = new QueueEvents(AUTOMATION_ENGINE_QUEUE_NAME, { connection: getRedisConnection() });
    await this.queueEvents.waitUntilReady();
    this.worker = new Worker(
      AUTOMATION_ENGINE_QUEUE_NAME,
      async (job: Job<{ automationId: string; triggerType: AutomationTriggerType }>) =>
        this.executeAutomationRun(job.data.automationId, job.data.triggerType),
      { connection: getRedisConnection(), concurrency: MAX_CONCURRENT_AUTOMATION_RUNS },
    );

    const scheduled = await listEnabledAutomations(this.deps.pool, "schedule");
    for (const automation of scheduled) {
      const cron = automation.trigger_config["cron"];
      if (typeof cron !== "string" || !cron) continue; // malformed config — skip quietly, never crash boot
      try {
        await this.queue.add(
          automation.id,
          { automationId: automation.id, triggerType: "schedule" as const },
          {
            repeat: { pattern: cron },
            jobId: `automation-repeat-${automation.id}`,
            attempts: DEFAULT_RETRY_ATTEMPTS,
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          },
        );
      } catch (err) {
        // `cron` is well-typed here but `createAutomationBodySchema` never
        // validates cron *syntax* at creation time (trigger_config is an
        // open record) — BullMQ's cron-parser throws synchronously inside
        // queue.add() for a malformed expression. One bad automation must
        // never block every other automation's schedule from registering,
        // or block the engine (and therefore the whole backend) from
        // finishing boot — same "skip and log, never crash boot" posture
        // as index.ts's external MCP server connection loop.
        this.deps.logger.error(
          { automationId: automation.id, cron, err },
          "failed to schedule automation — skipping it, other automations are unaffected",
        );
      }
    }

    this.unsubscribeEvents = this.deps.eventBus.subscribe((row) => void this.handleEvent(row));
    this.sweepInterval = setInterval(() => void this.sweepStuckRuns(), STUCK_RUN_SWEEP_MS);
  }

  async stop(): Promise<void> {
    if (this.sweepInterval) clearInterval(this.sweepInterval);
    this.unsubscribeEvents?.();
    await this.worker?.close();
    await this.queueEvents?.close();
    await this.queue?.close();
  }

  /** `POST /automations/:id/run` and the signed webhook route both land here. */
  async runNow(automationId: string, triggerType: AutomationTriggerType): Promise<AutomationRunRow> {
    if (!this.queue || !this.queueEvents) throw new Error("AutomationEngine not started");
    const job = await this.queue.add(
      `${automationId}-${triggerType}-${Date.now()}`,
      { automationId, triggerType },
      { attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
    await job.waitUntilFinished(this.queueEvents);
    const { listRecentAutomationRuns } = await import("../../db/repositories/automationRunRepo.js");
    const [latest] = await listRecentAutomationRuns(this.deps.pool, automationId, 1);
    if (!latest) throw new Error(`No run recorded for automation ${automationId} after run-now`);
    return latest;
  }

  /**
   * Fire-and-forget enqueue — the signed webhook route uses this instead
   * of `runNow` so an external caller (n8n) gets a fast 202 ack rather
   * than blocking on however long the automation's own action takes
   * (an `agent_task` can involve a full Master delegation tree).
   */
  async trigger(automationId: string, triggerType: AutomationTriggerType): Promise<void> {
    if (!this.queue) throw new Error("AutomationEngine not started");
    await this.queue.add(
      `${automationId}-${triggerType}-${Date.now()}`,
      { automationId, triggerType },
      { attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
  }

  /**
   * `trigger_type = 'event'` dispatch. Deliberately never matches an
   * `automation.*`-sourced event — an event-triggered automation chaining
   * off another automation's (or its own) `automation.triggered` event
   * would let automations fire each other in an unbounded cascade. Every
   * other event source (agent, bot, tool, model, system) is a legitimate
   * trigger.
   */
  private async handleEvent(row: EventRow): Promise<void> {
    if (row.source_type === "automation") return;
    const automations = await listEnabledAutomations(this.deps.pool, "event");
    for (const automation of automations) {
      const eventType = automation.trigger_config["eventType"];
      if (eventType !== row.event_type) continue;
      if (!this.queue) continue;
      await this.queue.add(
        `${automation.id}-event-${Date.now()}`,
        { automationId: automation.id, triggerType: "event" as const },
        { attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
    }
  }

  private async sweepStuckRuns(): Promise<void> {
    const stuck = await listStuckAutomationRuns(this.deps.pool);
    for (const run of stuck) {
      const message = `Run exceeded ${run.timeout_ms}ms and was marked timed out by the recovery sweep`;
      await completeAutomationRun(this.deps.pool, run.id, { status: "timeout", error: message });
      const durationMs = Date.now() - run.started_at.getTime();
      await this.deps.eventBus.publish({
        sourceType: "automation",
        sourceId: run.automation_id,
        payload: { type: "automation.run.completed", automationId: run.automation_id, automationRunId: run.id, status: "timeout", durationMs },
      });
      await this.deps.eventBus.publish({
        sourceType: "automation",
        sourceId: run.automation_id,
        severity: "warn",
        payload: { type: "automation.failed", automationId: run.automation_id, automationRunId: run.id, errorCode: "timeout", message },
      });
    }
  }

  private async executeAutomationRun(automationId: string, triggerType: AutomationTriggerType): Promise<void> {
    const automation = await getAutomation(this.deps.pool, automationId);
    if (!automation || !automation.enabled) return;

    const run = await createAutomationRun(this.deps.pool, automationId, triggerType);
    await markAutomationRan(this.deps.pool, automationId);
    await this.deps.eventBus.publish({
      sourceType: "automation",
      sourceId: automationId,
      payload: { type: "automation.triggered", automationId, automationRunId: run.id, triggerType },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), automation.timeout_ms);
    const start = Date.now();

    try {
      const result = await this.dispatch(automation, run.id, controller.signal);
      await completeAutomationRun(this.deps.pool, run.id, { status: "succeeded", result });
      await this.deps.eventBus.publish({
        sourceType: "automation",
        sourceId: automationId,
        payload: { type: "automation.run.completed", automationId, automationRunId: run.id, status: "succeeded", durationMs: Date.now() - start },
      });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      const status = timedOut ? "timeout" : "failed";
      const message = err instanceof Error ? err.message : String(err);
      await completeAutomationRun(this.deps.pool, run.id, { status, error: message });
      await this.deps.eventBus.publish({
        sourceType: "automation",
        sourceId: automationId,
        payload: { type: "automation.run.completed", automationId, automationRunId: run.id, status, durationMs: Date.now() - start },
      });
      await this.deps.eventBus.publish({
        sourceType: "automation",
        sourceId: automationId,
        severity: "warn",
        payload: { type: "automation.failed", automationId, automationRunId: run.id, errorCode: timedOut ? "timeout" : "run_failed", message },
      });
      throw err; // let BullMQ record the job failure; run-now callers see the completed (failed) run row regardless
    } finally {
      clearTimeout(timeout);
    }
  }

  private async dispatch(automation: AutomationRow, automationRunId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    switch (automation.action_type) {
      case "agent_task": {
        const result = await dispatchAgentTask(
          { pool: this.deps.pool, eventBus: this.deps.eventBus, modelRegistry: this.deps.modelRegistry, agentRegistry: this.deps.agentRegistry, toolRegistry: this.deps.toolRegistry },
          automation,
          automationRunId,
        );
        if (!result) return { skipped: "no background LLM credential opted in, or agent unavailable" };
        return { taskId: result.taskId, text: result.text };
      }
      case "n8n_workflow": {
        const result = await dispatchN8nWorkflow(automation, automationRunId, signal);
        return { status: result.status, responseSnippet: result.responseSnippet };
      }
      case "notification": {
        await dispatchNotification(
          { pool: this.deps.pool, eventBus: this.deps.eventBus, ownerId: this.deps.ownerId, sender: this.deps.notificationSender },
          automation,
        );
        return { notified: true };
      }
    }
  }
}
