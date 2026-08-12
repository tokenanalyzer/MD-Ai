import os from "node:os";
import type pg from "pg";
import type { Redis } from "ioredis";
import { Queue } from "bullmq";
import type { BotDefinition, BotRunContext, BotRunResult, FindingImportance, NormalizedFinding } from "@mdai/shared-types";
import { getRedisConnection } from "../../queue/connection.js";
import { BOT_ENGINE_QUEUE_NAME } from "./botEngine.js";

/**
 * M5.11: deterministic threshold checks only — never an LLM judgment.
 * Every check below is a fixed comparison against a fixed number; the
 * *interpretation* of a breach (what it means, what to do about it) is
 * what M5.12's escalation-when-appropriate step is for, not this bot.
 * Needs `pool`/`redis` beyond `BotRunContext`, so — like the User Topic
 * Monitor — this is a factory closing over the real connections at
 * registration time.
 */

interface ThresholdCheck {
  key: string;
  title: string;
  breached: boolean;
  importance: FindingImportance;
  summary: string;
  metadata: Record<string, unknown>;
}

const DB_LATENCY_WARN_MS = 500;
const REDIS_LATENCY_WARN_MS = 200;
const MEMORY_WARN_PCT = 85;
const LOAD_WARN_RATIO = 1.5; // loadavg(1m) vs. cpu count
const QUEUE_DEPTH_WARN = 50;

export function createSystemHealthMonitor(pool: pg.Pool, redis: Redis): BotDefinition {
  return {
    id: "system-health-monitor",
    displayName: "System Health Monitor",
    description:
      "Deterministically checks backend/Postgres/Redis/BullMQ/worker/CPU/memory/queue-depth/provider health against fixed thresholds — never an LLM judgment.",
    version: "0.1.0",
    category: "system_health",
    scheduleCron: "*/5 * * * *",
    defaultConfig: {},
    capabilities: ["system"],
    timeoutMs: 15000,

    async run(ctx: BotRunContext): Promise<BotRunResult> {
      const checks = await Promise.all([
        checkDatabase(pool),
        checkRedis(redis),
        checkMemory(),
        checkLoad(),
        checkQueueDepth(),
        checkProviderHealth(pool),
      ]);

      const findings: NormalizedFinding[] = checks
        .filter((c) => c.breached)
        .map((c) => ({
          category: "system_health",
          title: c.title,
          summary: c.summary,
          importance: c.importance,
          confidence: 1,
          sourceMetadata: c.metadata,
          payload: { check: c.key, ...c.metadata },
          dedupKey: c.key,
        }));

      void ctx.signal; // this bot makes no network calls that need cancellation, but the contract still passes one through

      return { status: "succeeded", findings, resourceMetadata: { checksRun: checks.length, checksBreached: findings.length } };
    },
  };
}

async function checkDatabase(pool: pg.Pool): Promise<ThresholdCheck> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    const latencyMs = Date.now() - start;
    return {
      key: "postgres_latency",
      title: "PostgreSQL responding slowly",
      breached: latencyMs > DB_LATENCY_WARN_MS,
      importance: "high",
      summary: `A simple SELECT 1 took ${latencyMs}ms (threshold ${DB_LATENCY_WARN_MS}ms).`,
      metadata: { latencyMs },
    };
  } catch (err) {
    return {
      key: "postgres_unreachable",
      title: "PostgreSQL unreachable",
      breached: true,
      importance: "critical",
      summary: `Database query failed: ${err instanceof Error ? err.message : String(err)}`,
      metadata: {},
    };
  }
}

async function checkRedis(redis: Redis): Promise<ThresholdCheck> {
  const start = Date.now();
  try {
    await redis.ping();
    const latencyMs = Date.now() - start;
    return {
      key: "redis_latency",
      title: "Redis responding slowly",
      breached: latencyMs > REDIS_LATENCY_WARN_MS,
      importance: "high",
      summary: `PING took ${latencyMs}ms (threshold ${REDIS_LATENCY_WARN_MS}ms).`,
      metadata: { latencyMs },
    };
  } catch (err) {
    return {
      key: "redis_unreachable",
      title: "Redis unreachable",
      breached: true,
      importance: "critical",
      summary: `Redis PING failed: ${err instanceof Error ? err.message : String(err)}`,
      metadata: {},
    };
  }
}

async function checkMemory(): Promise<ThresholdCheck> {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = ((total - free) / total) * 100;
  return {
    key: "memory_usage",
    title: "Host memory usage is high",
    breached: usedPct > MEMORY_WARN_PCT,
    importance: "medium",
    summary: `System memory usage is ${usedPct.toFixed(1)}% (threshold ${MEMORY_WARN_PCT}%).`,
    metadata: { usedPct: Number(usedPct.toFixed(1)), totalBytes: total },
  };
}

async function checkLoad(): Promise<ThresholdCheck> {
  const [load1] = os.loadavg();
  const cpuCount = os.cpus().length || 1;
  const ratio = (load1 ?? 0) / cpuCount;
  return {
    key: "cpu_load",
    title: "CPU load is high",
    breached: ratio > LOAD_WARN_RATIO,
    importance: "medium",
    summary: `1-minute load average is ${(load1 ?? 0).toFixed(2)} across ${cpuCount} CPU(s) (ratio ${ratio.toFixed(2)}, threshold ${LOAD_WARN_RATIO}).`,
    metadata: { load1, cpuCount },
  };
}

async function checkQueueDepth(): Promise<ThresholdCheck> {
  const queue = new Queue(BOT_ENGINE_QUEUE_NAME, { connection: getRedisConnection() });
  try {
    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    const depth = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    return {
      key: "bot_queue_depth",
      title: "Bot Engine queue is backing up",
      breached: depth > QUEUE_DEPTH_WARN,
      importance: "medium",
      summary: `${depth} jobs queued/active/delayed on the bot-engine queue (threshold ${QUEUE_DEPTH_WARN}).`,
      metadata: counts,
    };
  } finally {
    await queue.close();
  }
}

async function checkProviderHealth(pool: pg.Pool): Promise<ThresholdCheck> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*) FROM model_registry WHERE user_enabled = true AND availability = 'unavailable'",
  );
  const unavailableCount = Number(rows[0]?.count ?? "0");
  return {
    key: "provider_availability",
    title: "One or more enabled model providers are unavailable",
    breached: unavailableCount > 0,
    importance: "high",
    summary: `${unavailableCount} enabled model(s) currently report 'unavailable' in the Model Registry.`,
    metadata: { unavailableCount },
  };
}
