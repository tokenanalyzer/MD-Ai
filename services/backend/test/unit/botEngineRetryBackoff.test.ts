import "../setupEnv.js";
import { afterEach, describe, expect, it } from "vitest";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

/**
 * M5.2/M5.18: proves the retry/backoff *configuration shape* the Bot
 * Engine's scheduled jobs use (`attempts: 3, backoff: { type: "exponential" }`
 * — see core/bots/botEngine.ts's DEFAULT_RETRY_ATTEMPTS/BACKOFF_BASE_MS)
 * actually recovers a transiently-failing job, using real BullMQ against
 * the real test Redis instance rather than a mock. Uses a short backoff
 * delay here (the engine's own 5s base would make this test slow) —
 * what's under test is that the attempts/backoff wiring works at all, not
 * the specific delay value.
 */
const QUEUE_NAME = "bot-engine-retry-test";
let queue: Queue | undefined;
let worker: Worker | undefined;

afterEach(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => {});
  await queue?.close();
  queue = undefined;
  worker = undefined;
});

describe("Bot Engine retry/backoff — same BullMQ configuration shape as core/bots/botEngine.ts", () => {
  it("retries a job that fails on its first attempt and succeeds on a later one, per attempts+backoff", async () => {
    const connection = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAME, { connection });

    let attemptCount = 0;
    worker = new Worker(
      QUEUE_NAME,
      async (_job: Job) => {
        attemptCount++;
        if (attemptCount < 3) throw new Error(`simulated transient failure #${attemptCount}`);
        return { ok: true };
      },
      { connection, concurrency: 1 },
    );

    const job = await queue.add(
      "test-job",
      {},
      { attempts: 3, backoff: { type: "exponential", delay: 20 } },
    );

    const result = await new Promise((resolve, reject) => {
      worker!.on("completed", (j) => {
        if (j.id === job.id) resolve(j.returnvalue);
      });
      worker!.on("failed", (j, err) => {
        if (j && j.id === job.id && j.attemptsMade >= 3) reject(err);
      });
      setTimeout(() => reject(new Error("timed out waiting for retry to succeed")), 8000);
    });

    expect(result).toEqual({ ok: true });
    expect(attemptCount).toBe(3); // 2 failures + 1 success, exactly matching `attempts: 3`
    await connection.quit();
  }, 10000);

  it("permanently fails after exhausting all attempts — retries are bounded, not infinite", async () => {
    const connection = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAME, { connection });

    let attemptCount = 0;
    worker = new Worker(
      QUEUE_NAME,
      async (_job: Job) => {
        attemptCount++;
        throw new Error("always fails");
      },
      { connection, concurrency: 1 },
    );

    const job = await queue.add("always-fails", {}, { attempts: 2, backoff: { type: "fixed", delay: 20 } });

    await new Promise<void>((resolve, reject) => {
      worker!.on("failed", (j) => {
        if (j && j.id === job.id && j.attemptsMade >= 2) resolve();
      });
      setTimeout(() => reject(new Error("did not fail permanently in time")), 8000);
    });

    expect(attemptCount).toBe(2); // bounded by `attempts: 2`, never retried a third time
    await connection.quit();
  }, 10000);
});
