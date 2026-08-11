import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/core/router/circuitBreaker.js";

describe("CircuitBreaker", () => {
  it("stays closed and allows attempts while failures are below the threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canAttempt()).toBe(true);
  });

  it("opens after reaching the failure threshold and rejects further attempts", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.canAttempt()).toBe(false);
  });

  it("moves to half-open after the cooldown and closes again on success", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.getState()).toBe("half_open");
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("re-opens immediately if the half-open trial call fails", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    breaker.recordFailure();
    await new Promise((r) => setTimeout(r, 30));
    expect(breaker.canAttempt()).toBe(true); // half-open trial
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.canAttempt()).toBe(false);
  });
});
