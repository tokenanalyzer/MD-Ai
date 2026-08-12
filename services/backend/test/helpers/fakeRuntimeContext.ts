import type { Task } from "@mdai/shared-types";
import type { BackendAgentRuntimeContext } from "../../src/core/agents/runtimeContext.js";
import { ToolNotAvailableError } from "../../src/core/mcp/errors.js";

/**
 * A DB/HTTP-free stand-in for `BackendAgentRuntimeContext`, for unit-testing
 * a single agent's `handleTask` logic in isolation (no real model calls, no
 * Postgres). Every method throws by default — tests override only the
 * methods their scenario actually exercises, so an unexpected call (e.g.
 * "the reviewer must never call the model when refusing self-review")
 * fails loudly instead of silently succeeding.
 */
export function makeFakeCtx(
  task: Partial<Task> & Pick<Task, "id" | "assignedAgentId" | "taskType" | "state" | "input">,
  overrides: Partial<BackendAgentRuntimeContext> = {},
): BackendAgentRuntimeContext {
  const base: BackendAgentRuntimeContext = {
    task: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...task,
    },
    history: [],
    emit: () => {},
    selectModel: async () => {
      throw new Error("selectModel: not stubbed for this scenario");
    },
    completeChat: async () => {
      throw new Error("completeChat: not stubbed for this scenario");
    },
    // Real, honest default for M3 (no MCP host exists until M4) — matches
    // production behavior rather than a generic stub failure, so agents
    // that call a tool and handle ToolNotAvailableError get exercised by
    // default instead of every test having to override this.
    callTool: async (toolId) => {
      throw new ToolNotAvailableError(toolId);
    },
    delegate: async () => {
      throw new Error("delegate: not stubbed for this scenario");
    },
    streamChat: async () => {
      throw new Error("streamChat: not stubbed for this scenario");
    },
    addAssistantMessage: async () => {},
    finishCanceled: async () => {},
    start: async () => {},
    finishSuccess: async () => {
      throw new Error("finishSuccess: not stubbed for this scenario");
    },
    finishFailure: async () => {
      throw new Error("finishFailure: not stubbed for this scenario");
    },
    publishEvent: async () => {},
  };
  return { ...base, ...overrides };
}
