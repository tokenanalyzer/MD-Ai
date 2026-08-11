import "../setupEnv.js";
import { describe, expect, it } from "vitest";
import { rankCandidates, scoreCandidate } from "../../src/core/router/scoreModel.js";
import { fakeModelEntry } from "./fixtures/modelRegistryFixtures.js";

describe("scoreCandidate", () => {
  it("excludes a user-disabled model", () => {
    const entry = fakeModelEntry("groq/disabled", { userEnabled: false });
    const score = scoreCandidate(entry, { taskType: "chat", availableProviderIds: ["groq"] });
    expect(score.excluded).toBe(true);
    expect(score.exclusionReason).toContain("disabled");
  });

  it("excludes an unavailable model outright regardless of other stats", () => {
    const entry = fakeModelEntry("groq/down", { availability: "unavailable", avgLatencyMs: 10, errorRatePct: 0 });
    const score = scoreCandidate(entry, { taskType: "chat", availableProviderIds: ["groq"] });
    expect(score.excluded).toBe(true);
  });

  it("excludes on a hard capability requirement failure via taskCategory", () => {
    const entry = fakeModelEntry("groq/no-vision");
    const score = scoreCandidate(entry, { taskType: "chat", taskCategory: "vision", availableProviderIds: ["groq"] });
    expect(score.excluded).toBe(true);
  });

  it("excludes on an explicit requiredCapabilities miss", () => {
    const entry = fakeModelEntry("groq/no-tools");
    const score = scoreCandidate(entry, {
      taskType: "chat",
      availableProviderIds: ["groq"],
      requiredCapabilities: ["supportsTools"],
    });
    expect(score.excluded).toBe(true);
  });

  it("excludes when avgLatencyMs exceeds maxLatencyMs", () => {
    const entry = fakeModelEntry("groq/slow", { avgLatencyMs: 5000 });
    const score = scoreCandidate(entry, { taskType: "chat", availableProviderIds: ["groq"], maxLatencyMs: 1000 });
    expect(score.excluded).toBe(true);
  });

  it("scores available higher than degraded higher than unknown", () => {
    const available = scoreCandidate(fakeModelEntry("groq/a", { availability: "available" }), {
      taskType: "chat",
      availableProviderIds: ["groq"],
    });
    const degraded = scoreCandidate(fakeModelEntry("groq/b", { availability: "degraded" }), {
      taskType: "chat",
      availableProviderIds: ["groq"],
    });
    const unknown = scoreCandidate(fakeModelEntry("groq/c", { availability: "unknown" }), {
      taskType: "chat",
      availableProviderIds: ["groq"],
    });
    expect(available.availabilityScore).toBeGreaterThan(degraded.availabilityScore);
    expect(degraded.availabilityScore).toBeGreaterThan(unknown.availabilityScore);
  });

  it("scores lower latency higher, proportionally", () => {
    const fast = scoreCandidate(fakeModelEntry("groq/fast", { avgLatencyMs: 100 }), {
      taskType: "chat",
      availableProviderIds: ["groq"],
    });
    const slow = scoreCandidate(fakeModelEntry("groq/slow", { avgLatencyMs: 3000 }), {
      taskType: "chat",
      availableProviderIds: ["groq"],
    });
    expect(fast.latencyScore).toBeGreaterThan(slow.latencyScore);
  });

  it("doubles the latency weight for the 'fast' task category", () => {
    const entry = fakeModelEntry("groq/x", { avgLatencyMs: 100 });
    const normal = scoreCandidate(entry, { taskType: "chat", availableProviderIds: ["groq"] });
    const fastCategory = scoreCandidate(entry, { taskType: "chat", taskCategory: "fast", availableProviderIds: ["groq"] });
    expect(fastCategory.latencyScore).toBe(normal.latencyScore * 2);
  });

  it("gives unproven models (no samples) a neutral, not punitive, latency/error score", () => {
    const unproven = scoreCandidate(fakeModelEntry("groq/new"), { taskType: "chat", availableProviderIds: ["groq"] });
    const proven = scoreCandidate(fakeModelEntry("groq/proven", { avgLatencyMs: 5000, errorRatePct: 90 }), {
      taskType: "chat",
      availableProviderIds: ["groq"],
    });
    expect(unproven.latencyScore).toBeGreaterThan(proven.latencyScore);
    expect(unproven.errorRateScore).toBeGreaterThan(proven.errorRateScore);
  });

  it("rewards higher userPriority", () => {
    const low = scoreCandidate(fakeModelEntry("groq/low", { userPriority: 0 }), { taskType: "chat", availableProviderIds: ["groq"] });
    const high = scoreCandidate(fakeModelEntry("groq/high", { userPriority: 5 }), { taskType: "chat", availableProviderIds: ["groq"] });
    expect(high.userPriorityScore).toBeGreaterThan(low.userPriorityScore);
  });

  it("adds a bonus for being the provider's configured default model", () => {
    const entry = fakeModelEntry("groq/x");
    const notDefault = scoreCandidate(entry, { taskType: "chat", availableProviderIds: ["groq"] });
    const isDefault = scoreCandidate(entry, { taskType: "chat", availableProviderIds: ["groq"] }, { isProviderDefaultModel: true });
    expect(isDefault.userPriorityScore).toBeGreaterThan(notDefault.userPriorityScore);
  });

  it("adds a reasoning bonus only for reasoning-preferred categories", () => {
    const reasoner = fakeModelEntry("nvidia-nemotron/x", {
      capabilities: { ...fakeModelEntry("x").capabilities, supportsReasoning: true },
    });
    const plainCategoryScore = scoreCandidate(reasoner, { taskType: "chat", availableProviderIds: ["nvidia-nemotron"] });
    const reasoningCategoryScore = scoreCandidate(reasoner, {
      taskType: "chat",
      taskCategory: "reasoning",
      availableProviderIds: ["nvidia-nemotron"],
    });
    expect(reasoningCategoryScore.capabilityScore).toBeGreaterThan(plainCategoryScore.capabilityScore);
  });
});

describe("rankCandidates", () => {
  it("sorts excluded candidates after all non-excluded ones, regardless of any score", () => {
    const good = fakeModelEntry("groq/good");
    const disabled = fakeModelEntry("groq/bad", { userEnabled: false });
    const ranked = rankCandidates([disabled, good], { taskType: "chat", availableProviderIds: ["groq"] });
    expect(ranked[0]?.modelId).toBe("groq/good");
    expect(ranked[1]?.modelId).toBe("groq/bad");
    expect(ranked[1]?.excluded).toBe(true);
  });

  it("sorts non-excluded candidates by total score descending", () => {
    const worse = fakeModelEntry("groq/worse", { avgLatencyMs: 4000, errorRatePct: 50 });
    const better = fakeModelEntry("groq/better", { avgLatencyMs: 100, errorRatePct: 0 });
    const ranked = rankCandidates([worse, better], { taskType: "chat", availableProviderIds: ["groq"] });
    expect(ranked[0]?.modelId).toBe("groq/better");
    expect(ranked[0]!.totalScore).toBeGreaterThan(ranked[1]!.totalScore);
  });
});
