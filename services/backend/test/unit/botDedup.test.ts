import { describe, expect, it } from "vitest";
import { cooldownUntilFor, ESCALATION_MIN_IMPORTANCE, isUnderCooldown, meetsImportanceThreshold } from "../../src/core/bots/dedup.js";

describe("M5.6 — deterministic importance threshold", () => {
  it("ranks importance levels consistently regardless of comparison direction", () => {
    expect(meetsImportanceThreshold("critical", "low")).toBe(true);
    expect(meetsImportanceThreshold("low", "critical")).toBe(false);
    expect(meetsImportanceThreshold("medium", "medium")).toBe(true);
    expect(meetsImportanceThreshold("low", "medium")).toBe(false);
  });

  it("ESCALATION_MIN_IMPORTANCE gates exactly medium and above", () => {
    expect(meetsImportanceThreshold("low", ESCALATION_MIN_IMPORTANCE)).toBe(false);
    expect(meetsImportanceThreshold("medium", ESCALATION_MIN_IMPORTANCE)).toBe(true);
    expect(meetsImportanceThreshold("high", ESCALATION_MIN_IMPORTANCE)).toBe(true);
    expect(meetsImportanceThreshold("critical", ESCALATION_MIN_IMPORTANCE)).toBe(true);
  });
});

describe("M5.5 — deduplication cooldown", () => {
  it("gives higher importance a shorter cooldown, not a longer one", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const critical = cooldownUntilFor("critical", now).getTime() - now.getTime();
    const high = cooldownUntilFor("high", now).getTime() - now.getTime();
    const medium = cooldownUntilFor("medium", now).getTime() - now.getTime();
    const low = cooldownUntilFor("low", now).getTime() - now.getTime();
    expect(critical).toBeLessThan(high);
    expect(high).toBeLessThan(medium);
    expect(medium).toBeLessThan(low);
  });

  it("treats null as never under cooldown", () => {
    expect(isUnderCooldown(null)).toBe(false);
  });

  it("treats a future cooldown as active and a past one as expired", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const future = new Date(now.getTime() + 60_000);
    const past = new Date(now.getTime() - 60_000);
    expect(isUnderCooldown(future, now)).toBe(true);
    expect(isUnderCooldown(past, now)).toBe(false);
  });
});
