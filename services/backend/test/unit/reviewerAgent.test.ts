import { describe, expect, it } from "vitest";
import { createReviewerAgent } from "../../src/core/agents/reviewer/reviewerAgent.js";
import { makeFakeCtx } from "../helpers/fakeRuntimeContext.js";

describe("Reviewer Agent (M3.5)", () => {
  it("fails closed with no model call when no result is given to review", async () => {
    const reviewer = createReviewerAgent();
    let failure: { code: string; message: string; retryable: boolean } | undefined;
    const ctx = makeFakeCtx(
      { id: "t1", assignedAgentId: "reviewer", taskType: "review", state: "working", input: { targetAgentId: "research" } },
      {
        completeChat: async () => {
          throw new Error("must not call the model with nothing to review");
        },
        finishFailure: async (error) => void (failure = error),
      },
    );

    await reviewer.handleTask(ctx);

    expect(failure?.code).toBe("missing_review_target");
  });

  it("fails closed to REVISE (never a crash) when the model doesn't return a well-formed verdict", async () => {
    const reviewer = createReviewerAgent();
    let output: Record<string, unknown> | undefined;
    const publishedEvents: string[] = [];
    const ctx = makeFakeCtx(
      {
        id: "t2",
        assignedAgentId: "reviewer",
        taskType: "review",
        state: "working",
        input: {
          targetAgentId: "research",
          targetTaskId: "t-research",
          result: { objective: "x", findings: [{ claim: "y", kind: "fact", source: null }], limitations: [], toolsUsed: [] },
        },
      },
      {
        completeChat: async () => ({ text: "garbage, not json", modelId: "m", providerId: "p" }),
        finishSuccess: async (o) => void (output = o),
        publishEvent: async (payload) => void publishedEvents.push(payload.type),
      },
    );

    await reviewer.handleTask(ctx);

    expect(output).toMatchObject({ decision: "REVISE" });
    expect(publishedEvents).toEqual(["review.started", "review.completed"]);
  });

  it("reports the model's APPROVE verdict verbatim with review.started/completed events", async () => {
    const reviewer = createReviewerAgent();
    let output: Record<string, unknown> | undefined;
    const decisions: string[] = [];
    const ctx = makeFakeCtx(
      {
        id: "t3",
        assignedAgentId: "reviewer",
        taskType: "review",
        state: "working",
        input: {
          targetAgentId: "research",
          targetTaskId: "t-research",
          result: { objective: "x", findings: [{ claim: "y", kind: "fact", source: null }], limitations: ["web_search_unavailable"], toolsUsed: [] },
        },
      },
      {
        completeChat: async () => ({
          text: JSON.stringify({ decision: "APPROVE", issues: [], summary: "Clean and well-disclosed." }),
          modelId: "m",
          providerId: "p",
        }),
        finishSuccess: async (o) => void (output = o),
        publishEvent: async (payload) => {
          if (payload.type === "review.completed") decisions.push((payload as { decision: string }).decision);
        },
      },
    );

    await reviewer.handleTask(ctx);

    expect(output).toMatchObject({ decision: "APPROVE", summary: "Clean and well-disclosed." });
    expect(decisions).toEqual(["APPROVE"]);
  });
});
