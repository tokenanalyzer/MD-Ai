import { describe, expect, it } from "vitest";
import { createResearchAgent } from "../../src/core/agents/research/researchAgent.js";
import { makeFakeCtx } from "../helpers/fakeRuntimeContext.js";

describe("Research Agent (M3.3)", () => {
  it("fails closed with no model call when no objective is provided", async () => {
    const research = createResearchAgent();
    let failure: { code: string; message: string; retryable: boolean } | undefined;
    const ctx = makeFakeCtx(
      { id: "t1", assignedAgentId: "research", taskType: "research", state: "working", input: {} },
      {
        completeChat: async () => {
          throw new Error("must not call the model with no objective");
        },
        finishFailure: async (error) => void (failure = error),
      },
    );

    await research.handleTask(ctx);

    expect(failure?.code).toBe("missing_objective");
  });

  it("always discloses the lack of live tool access, never fabricating a source", async () => {
    const research = createResearchAgent();
    let output: Record<string, unknown> | undefined;
    const ctx = makeFakeCtx(
      { id: "t2", assignedAgentId: "research", taskType: "research", state: "working", input: { objective: "What is A2A?" } },
      {
        completeChat: async () => ({
          text: JSON.stringify({
            objective: "What is A2A?",
            findings: [{ claim: "A2A defines Task/AgentCard/Message concepts.", kind: "fact", source: null }],
            limitations: [],
            toolsUsed: [],
          }),
          modelId: "groq/llama-3.3-70b-versatile",
          providerId: "groq",
        }),
        finishSuccess: async (o) => void (output = o),
      },
    );

    await research.handleTask(ctx);

    const limitations = (output?.["limitations"] as string[]) ?? [];
    expect(limitations.some((l) => l.includes("web_search_unavailable"))).toBe(true);
    const findings = output?.["findings"] as { source: string | null }[];
    expect(findings.every((f) => f.source === null)).toBe(true);
  });

  it("feeds the reviewer's prior feedback into the revision prompt", async () => {
    const research = createResearchAgent();
    let sentPrompt = "";
    const ctx = makeFakeCtx(
      {
        id: "t3",
        assignedAgentId: "research",
        taskType: "research",
        state: "working",
        input: { objective: "What is A2A?", reviewerFeedback: "unsupported_claim: the exact version number was invented" },
      },
      {
        completeChat: async (input) => {
          sentPrompt = input.messages.map((m) => m.content).join("\n");
          return {
            text: JSON.stringify({ objective: "What is A2A?", findings: [], limitations: ["web_search_unavailable"], toolsUsed: [] }),
            modelId: "m",
            providerId: "p",
          };
        },
        finishSuccess: async () => {},
      },
    );

    await research.handleTask(ctx);

    expect(sentPrompt).toContain("unsupported_claim");
    expect(sentPrompt).toContain("Revise your findings");
  });

  it("fails closed (retryable) when the model doesn't return well-formed structured output", async () => {
    const research = createResearchAgent();
    let failure: { code: string; message: string; retryable: boolean } | undefined;
    const ctx = makeFakeCtx(
      { id: "t4", assignedAgentId: "research", taskType: "research", state: "working", input: { objective: "hi" } },
      {
        completeChat: async () => ({ text: "not json at all", modelId: "m", providerId: "p" }),
        finishFailure: async (error) => void (failure = error),
      },
    );

    await research.handleTask(ctx);

    expect(failure).toMatchObject({ code: "research_output_invalid", retryable: true });
  });
});
