import os from "node:os";
import type pg from "pg";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { getLatencyStats, type RouteLatencyStats } from "./latencyTracker.js";

export interface HealthReport {
  status: "ok" | "degraded" | "error";
  timestamp: string;
  cpu: { loadavg1: number; loadavg5: number; loadavg15: number; cpuCount: number };
  memory: { processRssMb: number; systemFreeMb: number; systemTotalMb: number };
  postgres: { ok: boolean; latencyMs?: number; poolTotal: number; poolIdle: number; poolWaiting: number; error?: string };
  // `disabled: true` means REDIS_URL isn't configured — Bot Engine,
  // Automation Engine, and maintenance workers are intentionally off, not
  // erroring. `ok` stays true in that case so this alone never flips
  // overall `status` to "error".
  redis: { ok: boolean; disabled?: boolean; latencyMs?: number; usedMemoryMb?: number; connectedClients?: number; error?: string };
  queues: { name: string; waiting: number; active: number; completed: number; failed: number; workerCount: number }[];
  requestLatency: Record<string, RouteLatencyStats>;
}

/** Resource telemetry (docs/architecture/08-deployment-architecture.md §9.1). Cheap enough to compute per /health call at M1 scale. */
export async function buildHealthReport(deps: { pool: pg.Pool; redis: Redis | undefined; queues: Queue[] }): Promise<HealthReport> {
  const load = os.loadavg();
  const cpu = { loadavg1: load[0] ?? 0, loadavg5: load[1] ?? 0, loadavg15: load[2] ?? 0, cpuCount: os.cpus().length };
  const memory = {
    processRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
    systemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
  };

  let postgres: HealthReport["postgres"];
  try {
    const start = Date.now();
    await deps.pool.query("SELECT 1");
    postgres = {
      ok: true,
      latencyMs: Date.now() - start,
      poolTotal: deps.pool.totalCount,
      poolIdle: deps.pool.idleCount,
      poolWaiting: deps.pool.waitingCount,
    };
  } catch (err) {
    postgres = {
      ok: false,
      poolTotal: deps.pool.totalCount,
      poolIdle: deps.pool.idleCount,
      poolWaiting: deps.pool.waitingCount,
      error: (err as Error).message,
    };
  }

  let redis: HealthReport["redis"];
  if (!deps.redis) {
    redis = { ok: true, disabled: true };
  } else {
    try {
      const start = Date.now();
      await deps.redis.ping();
      const latencyMs = Date.now() - start;
      const info = await deps.redis.info("memory,clients");
      const usedMemoryMatch = /used_memory:(\d+)/.exec(info);
      const clientsMatch = /connected_clients:(\d+)/.exec(info);
      redis = {
        ok: true,
        latencyMs,
        usedMemoryMb: usedMemoryMatch?.[1] ? Math.round(Number(usedMemoryMatch[1]) / 1024 / 1024) : undefined,
        connectedClients: clientsMatch?.[1] ? Number(clientsMatch[1]) : undefined,
      };
    } catch (err) {
      redis = { ok: false, error: (err as Error).message };
    }
  }

  const queues = await Promise.all(
    deps.queues.map(async (q) => {
      const counts = await q.getJobCounts("waiting", "active", "completed", "failed");
      const workers = await q.getWorkers();
      return {
        name: q.name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        workerCount: workers.length,
      };
    }),
  );

  const status: HealthReport["status"] =
    !postgres.ok || !redis.ok ? "error" : (postgres.latencyMs ?? 0) > 500 ? "degraded" : "ok";

  return {
    status,
    timestamp: new Date().toISOString(),
    cpu,
    memory,
    postgres,
    redis,
    queues,
    requestLatency: getLatencyStats(),
  };
}
