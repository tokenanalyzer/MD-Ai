import "../setupEnv.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, resetEnvCacheForTests } from "../../src/config/env.js";
import { getRedisConnection } from "../../src/queue/connection.js";

const originalRedisUrl = process.env.REDIS_URL;

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
  resetEnvCacheForTests();
});

describe("REDIS_URL is optional in the env schema", () => {
  it("REDIS_URL present: loadEnv returns it unchanged", () => {
    process.env.REDIS_URL = "redis://localhost:6379/1";
    resetEnvCacheForTests();
    expect(loadEnv().REDIS_URL).toBe("redis://localhost:6379/1");
  });

  it("REDIS_URL absent: loadEnv still succeeds (does not throw), REDIS_URL is undefined", () => {
    delete process.env.REDIS_URL;
    resetEnvCacheForTests();
    expect(() => loadEnv()).not.toThrow();
    expect(loadEnv().REDIS_URL).toBeUndefined();
  });

  it("REDIS_URL absent: getRedisConnection() throws a clear error rather than connecting to a default host — no Redis connection is ever attempted when unconfigured", () => {
    delete process.env.REDIS_URL;
    resetEnvCacheForTests();
    expect(() => getRedisConnection()).toThrow(/REDIS_URL/);
  });
});
