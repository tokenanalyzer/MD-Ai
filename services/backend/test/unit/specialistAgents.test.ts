import { describe, expect, it } from "vitest";
import { createSpecialistAgents } from "../../src/core/agents/specialist/specialists.js";
import { ToolNotAvailableError } from "../../src/core/mcp/errors.js";
import { makeFakeCtx } from "../helpers/fakeRuntimeContext.js";

describe("M8 specialist agents — roster", () => {
  it("registers exactly the six roadmap specialists, each with a distinct capability Master can match on", () => {
    const specialists = createSpecialistAgents();
    const byId = new Map(specialists.map((a) => [a.card.id, a]));

    expect([...byId.keys()].sort()).toEqual([
      "ai-radar",
      "business-intel",
      "crypto-intel",
      "news-intel",
      "social-media",
      "stock-intel",
    ]);
    expect(byId.get("crypto-intel")?.card.capabilities).toEqual(["crypto-analysis"]);
    expect(byId.get("stock-intel")?.card.capabilities).toEqual(["stock-analysis"]);
    expect(byId.get("business-intel")?.card.capabilities).toEqual(["business-research"]);
    expect(byId.get("social-media")?.card.capabilities).toEqual(["social-analysis"]);
    expect(byId.get("ai-radar")?.card.capabilities).toEqual(["ai-landscape-tracking"]);
    expect(byId.get("news-intel")?.card.capabilities).toEqual(["news-synthesis"]);

    // Every capability tag must be unique, or Master's classifier can't
    // tell two specialists apart.
    const allCapabilities = specialists.flatMap((a) => a.card.capabilities);
    expect(new Set(allCapabilities).size).toBe(allCapabilities.length);

    // None may delegate onward — same non-chaining rule as Research/Reviewer.
    for (const specialist of specialists) {
      expect(specialist.card.isInternal).toBe(true);
      expect(specialist.card.supportedTaskTypes).toEqual(["research"]);
    }
  });
});

describe("M8 specialist agent factory — reuses Research's real pipeline", () => {
  it("fails closed with no model call when no objective is provided (crypto-intel)", async () => {
    const [cryptoIntel] = createSpecialistAgents();
    let failure: { code: string; message: string; retryable: boolean } | undefined;
    const ctx = makeFakeCtx(
      { id: "t1", assignedAgentId: "crypto-intel", taskType: "research", state: "working", input: {} },
      {
        completeChat: async () => {
          throw new Error("must not call the model with no objective");
        },
        finishFailure: async (error) => void (failure = error),
      },
    );

    await cryptoIntel!.handleTask(ctx);
    expect(failure?.code).toBe("missing_objective");
  });

  it("honestly discloses no live market/on-chain access and never fabricates a source (crypto-intel)", async () => {
    const [cryptoIntel] = createSpecialistAgents();
    let output: Record<string, unknown> | undefined;
    const ctx = makeFakeCtx(
      { id: "t2", assignedAgentId: "crypto-intel", taskType: "research", state: "working", input: { objective: "Latest on Bitcoin ETFs" } },
      {
        completeChat: async () => ({
          text: JSON.stringify({
            objective: "Latest on Bitcoin ETFs",
            findings: [{ claim: "Spot Bitcoin ETFs exist in the US.", kind: "fact", source: null }],
            limitations: [],
            toolsUsed: [],
          }),
          modelId: "groq/llama-3.3-70b-versatile",
          providerId: "groq",
        }),
        finishSuccess: async (o) => void (output = o),
      },
    );

    await cryptoIntel!.handleTask(ctx);

    const limitations = (output?.["limitations"] as string[]) ?? [];
    expect(limitations.some((l) => l.includes("web_search_unavailable"))).toBe(true);
    const findings = output?.["findings"] as { source: string | null }[];
    expect(findings.every((f) => f.source === null)).toBe(true);
  });

  it("strips a hallucinated source URL that was never actually retrieved this turn (business-intel)", async () => {
    const specialists = createSpecialistAgents();
    const businessIntel = specialists.find((a) => a.card.id === "business-intel")!;
    let output: Record<string, unknown> | undefined;
    const ctx = makeFakeCtx(
      { id: "t3", assignedAgentId: "business-intel", taskType: "research", state: "working", input: { objective: "Recent acquisitions" } },
      {
        callTool: async () => {
          throw new ToolNotAvailableError("web_search");
        },
        completeChat: async () => ({
          text: JSON.stringify({
            objective: "Recent acquisitions",
            findings: [{ claim: "Company X acquired Company Y.", kind: "fact", source: "https://invented-not-retrieved.example/article" }],
            limitations: [],
            toolsUsed: [],
          }),
          modelId: "m",
          providerId: "p",
        }),
        finishSuccess: async (o) => void (output = o),
      },
    );

    await businessIntel.handleTask(ctx);

    const findings = output?.["findings"] as { source: string | null; kind: string }[];
    expect(findings[0]?.source).toBeNull();
    expect(findings[0]?.kind).toBe("uncertain");
  });
});
