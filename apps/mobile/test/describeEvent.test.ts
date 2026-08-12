import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/lib/describeEvent";
import type { EventDto } from "../src/api/client";

function event(type: string, payload: Record<string, unknown> = {}): EventDto {
  return {
    id: 1,
    type,
    sourceType: "agent",
    sourceId: "master",
    severity: "info",
    payload,
    createdAt: new Date().toISOString(),
  };
}

describe("describeEvent", () => {
  it("renders agent lifecycle events with only safe fields", () => {
    expect(describeEvent(event("agent.started", { agentId: "research" }))).toBe("research started");
    expect(describeEvent(event("agent.completed", { agentId: "research", durationMs: 420 }))).toBe(
      "research completed in 420ms",
    );
    expect(describeEvent(event("agent.failed", { agentId: "research", errorCode: "timeout" }))).toBe(
      "research failed: timeout",
    );
  });

  it("renders tool events without ever including arguments/results", () => {
    const withArgs = event("tool.called", { toolId: "web_search", arguments: { query: "secret plan" } });
    const label = describeEvent(withArgs);
    expect(label).toBe("Tool called: web_search");
    expect(label).not.toContain("secret plan");
  });

  it("renders model routing events", () => {
    expect(describeEvent(event("model.selected", { modelId: "groq/llama-3.3-70b" }))).toBe(
      "Model selected: groq/llama-3.3-70b",
    );
    expect(describeEvent(event("model.switched", { fromModelId: "a", toModelId: "b" }))).toBe(
      "Model switched: a → b",
    );
  });

  it("renders bot events", () => {
    expect(describeEvent(event("bot.run.completed", { botId: "system-health", status: "succeeded", findingsCount: 2 }))).toBe(
      "system-health run succeeded (2 finding(s))",
    );
    expect(describeEvent(event("bot.finding.escalated", { botId: "system-health" }))).toBe(
      "system-health: finding escalated to Master",
    );
  });

  it("falls back to the raw type for an unrecognized event, never throwing", () => {
    expect(describeEvent(event("some.future.event.type"))).toBe("some.future.event.type");
  });

  it("never surfaces a chain-of-thought-shaped payload field even if present", () => {
    const withReasoning = event("agent.started", { agentId: "master", reasoning: "step by step thinking..." });
    expect(describeEvent(withReasoning)).toBe("master started");
  });
});
