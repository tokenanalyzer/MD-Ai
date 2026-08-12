import type pg from "pg";
import type { ToolDefinition, ToolHandler } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import type { ToolRegistryService } from "./toolRegistryService.js";
import {
  completeToolInvocation,
  createToolInvocation,
  getToolInvocation,
  updateToolHealth,
  type ToolInvocationRow,
} from "../../db/repositories/toolRepo.js";
import { writeAuditLog } from "../../db/repositories/auditLogRepo.js";
import {
  ToolApprovalDeniedError,
  ToolApprovalRequiredError,
  ToolNotAvailableError,
  ToolPermissionDeniedError,
  ToolResumptionNotAllowedError,
  ToolTimeoutError,
} from "./errors.js";
import { evaluateToolApprovalPolicy } from "../agents/guardian/policy.js";
import { UnsafeUrlError } from "../security/ssrfGuard.js";

export interface McpHostDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  toolRegistry: ToolRegistryService;
}

export interface InvokeToolRequest {
  toolId: string;
  agentId: string;
  taskId?: string;
  input: Record<string, unknown>;
  /** Transient, request-scoped tool credentials (e.g. a search provider key) — never persisted, never logged, never included in an event. */
  toolKeys: Record<string, string>;
}

/**
 * The M4.2 MCP execution layer — the *only* path from an agent to a tool:
 * Agent → Tool Registry (discover) → Permission Check → MCP Tool
 * (execute, timeout-bounded) → Result → Agent. Every step publishes a
 * metadata-only event (`tool.discovered`/`.selected`/`.permission.checked`/
 * `.called`/`.completed`/`.failed`/`.timeout`/`.blocked`) and every
 * invocation is durably recorded in `tool_invocations` — but neither the
 * events nor the DB row ever receive `toolKeys` or any other secret.
 */
export async function invokeTool(deps: McpHostDeps, request: InvokeToolRequest): Promise<Record<string, unknown>> {
  const { pool, eventBus, toolRegistry } = deps;
  const { toolId, agentId, taskId, input, toolKeys } = request;

  const definition = await toolRegistry.get(toolId);
  if (!definition || !definition.enabled) {
    throw new ToolNotAvailableError(toolId);
  }
  await eventBus.publish({
    sourceType: "tool",
    sourceId: toolId,
    taskId,
    payload: { type: "tool.discovered", toolId, agentId, taskId },
  });

  const accessLevel = await toolRegistry.checkPermission(agentId, toolId);
  await eventBus.publish({
    sourceType: "tool",
    sourceId: toolId,
    taskId,
    payload: { type: "tool.permission.checked", toolId, agentId, accessLevel: accessLevel ?? "denied" },
  });
  if (!accessLevel) {
    await eventBus.publish({
      sourceType: "tool",
      sourceId: toolId,
      taskId,
      severity: "warn",
      payload: { type: "tool.blocked", toolId, agentId, reason: "no agent_tool_grants row authorizes this call" },
    });
    throw new ToolPermissionDeniedError(agentId, toolId);
  }

  if (definition.requiresApproval) {
    const verdict = evaluateToolApprovalPolicy({ toolId, agentId, riskLevel: definition.riskLevel, accessLevel });
    const gateStart = Date.now();
    const gateInvocation = await createToolInvocation(pool, { toolId, taskId, agentId, input });

    if (verdict.decision === "deny") {
      await completeToolInvocation(pool, gateInvocation.id, {
        status: "denied",
        errorCode: "guardian_denied",
        error: verdict.reason,
        latencyMs: Date.now() - gateStart,
      });
      await eventBus.publish({
        sourceType: "tool",
        sourceId: toolId,
        taskId,
        severity: "warn",
        payload: { type: "tool.blocked", toolId, agentId, invocationId: gateInvocation.id, reason: verdict.reason },
      });
      await writeAuditLog(pool, {
        actor: "guardian",
        action: "tool_approval.denied",
        targetType: "tool_invocation",
        targetId: gateInvocation.id,
        metadata: { toolId, agentId, reason: verdict.reason },
      });
      throw new ToolApprovalDeniedError(toolId, agentId, verdict.reason);
    }

    await completeToolInvocation(pool, gateInvocation.id, {
      status: "awaiting_approval",
      latencyMs: Date.now() - gateStart,
    });
    await eventBus.publish({
      sourceType: "tool",
      sourceId: toolId,
      taskId,
      severity: "warn",
      payload: { type: "tool.blocked", toolId, agentId, invocationId: gateInvocation.id, reason: verdict.reason },
    });
    await writeAuditLog(pool, {
      actor: "guardian",
      action: "tool_approval.pending",
      targetType: "tool_invocation",
      targetId: gateInvocation.id,
      metadata: { toolId, agentId, reason: verdict.reason },
    });
    throw new ToolApprovalRequiredError(toolId, agentId, gateInvocation.id);
  }

  const handler = toolRegistry.getImplementation(toolId);
  if (!handler) {
    throw new ToolNotAvailableError(toolId);
  }

  const invocationRow = await createToolInvocation(pool, { toolId, taskId, agentId, input });
  await eventBus.publish({
    sourceType: "tool",
    sourceId: toolId,
    taskId,
    payload: { type: "tool.selected", toolId, agentId, taskId, invocationId: invocationRow.id },
  });
  await eventBus.publish({
    sourceType: "tool",
    sourceId: toolId,
    taskId,
    payload: { type: "tool.called", toolId, agentId, taskId, invocationId: invocationRow.id },
  });

  return runToolHandler(deps, definition, handler, { toolId, agentId, taskId, input, toolKeys }, invocationRow);
}

/**
 * M9: a human approved a `tool_invocations` row Guardian left
 * `awaiting_approval` (M8) — this actually replays the original call,
 * closing the gap M8 explicitly left open ("no task-resumption mechanism
 * exists to replay/re-execute the original tool call"). Reuses the exact
 * same timeout-bounded execution path `invokeTool` uses via
 * `runToolHandler`, against the SAME invocation row (its status moves
 * `approved` → `succeeded`/`failed`/`timeout`, never a second row) — a
 * resumed call is a continuation of one tool call's lifecycle, not a new
 * one. `toolKeys` are never persisted anywhere (same discipline as a
 * fresh request): the original request's keys are long gone by the time a
 * human approves later, so a human approving a `requires_approval` tool
 * that also needs a fresh credential supplies one at approval time (`POST
 * /tools/approvals/:id/decide` body) — empty for every tool that doesn't
 * need one, which today is every built-in tool (M8: none currently ship
 * `requiresApproval: true`).
 */
export async function resumeApprovedToolInvocation(
  deps: McpHostDeps,
  invocationId: string,
  toolKeys: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { pool, eventBus, toolRegistry } = deps;

  const invocationRow = await getToolInvocation(pool, invocationId);
  if (!invocationRow || invocationRow.status !== "approved") {
    throw new ToolResumptionNotAllowedError(invocationId, invocationRow?.status);
  }
  if (!invocationRow.agent_id) {
    throw new ToolResumptionNotAllowedError(invocationId, invocationRow.status);
  }

  const definition = await toolRegistry.get(invocationRow.tool_id);
  if (!definition || !definition.enabled) {
    throw new ToolNotAvailableError(invocationRow.tool_id);
  }
  const handler = toolRegistry.getImplementation(invocationRow.tool_id);
  if (!handler) {
    throw new ToolNotAvailableError(invocationRow.tool_id);
  }

  await eventBus.publish({
    sourceType: "tool",
    sourceId: invocationRow.tool_id,
    taskId: invocationRow.task_id ?? undefined,
    payload: {
      type: "tool.resumed",
      toolId: invocationRow.tool_id,
      agentId: invocationRow.agent_id,
      invocationId: invocationRow.id,
    },
  });

  return runToolHandler(
    deps,
    definition,
    handler,
    {
      toolId: invocationRow.tool_id,
      agentId: invocationRow.agent_id,
      taskId: invocationRow.task_id ?? undefined,
      input: invocationRow.input,
      toolKeys,
    },
    invocationRow,
  );
}

/**
 * The shared timeout-bounded "actually call the handler, complete the
 * invocation, publish the lifecycle events" core — used by both a fresh
 * `invokeTool` call (post-gate) and `resumeApprovedToolInvocation` (same
 * row, later). Never creates or looks up the invocation row itself; the
 * caller owns that, since a fresh call and a resumed call get there
 * differently.
 */
async function runToolHandler(
  deps: McpHostDeps,
  definition: ToolDefinition,
  handler: ToolHandler,
  request: InvokeToolRequest,
  invocationRow: ToolInvocationRow,
): Promise<Record<string, unknown>> {
  const { pool, eventBus } = deps;
  const { toolId, agentId, taskId, input, toolKeys } = request;

  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), definition.timeoutMs);

  try {
    const output = await handler.invoke(input, {
      invocationId: invocationRow.id,
      agentId,
      taskId,
      signal: controller.signal,
      toolKeys,
    });
    const latencyMs = Date.now() - start;
    await completeToolInvocation(pool, invocationRow.id, {
      status: "succeeded",
      output,
      resultMetadata: summarizeOutput(output),
      latencyMs,
    });
    await eventBus.publish({
      sourceType: "tool",
      sourceId: toolId,
      taskId,
      payload: { type: "tool.completed", toolId, invocationId: invocationRow.id, status: "succeeded", latencyMs },
    });
    void updateToolHealth(pool, toolId, "healthy");
    return output;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const aborted = controller.signal.aborted;

    if (aborted) {
      await completeToolInvocation(pool, invocationRow.id, {
        status: "timeout",
        errorCode: "timeout",
        error: `Timed out after ${definition.timeoutMs}ms`,
        latencyMs,
      });
      await eventBus.publish({
        sourceType: "tool",
        sourceId: toolId,
        taskId,
        severity: "warn",
        payload: { type: "tool.timeout", toolId, invocationId: invocationRow.id, timeoutMs: definition.timeoutMs },
      });
      void updateToolHealth(pool, toolId, "degraded", "timed out");
      throw new ToolTimeoutError(toolId, definition.timeoutMs);
    }

    const isSecurityBlock = err instanceof UnsafeUrlError;
    const isToolNotAvailable = err instanceof ToolNotAvailableError;
    const errorCode = isSecurityBlock ? "unsafe_url" : isToolNotAvailable ? "tool_not_available" : (err as Error).name || "tool_error";
    const message = (err as Error).message;

    if (isSecurityBlock) {
      await completeToolInvocation(pool, invocationRow.id, { status: "blocked", errorCode, error: message, latencyMs });
      await eventBus.publish({
        sourceType: "tool",
        sourceId: toolId,
        taskId,
        severity: "warn",
        payload: { type: "tool.blocked", toolId, agentId, invocationId: invocationRow.id, reason: message },
      });
    } else {
      await completeToolInvocation(pool, invocationRow.id, { status: "failed", errorCode, error: message, latencyMs });
      await eventBus.publish({
        sourceType: "tool",
        sourceId: toolId,
        taskId,
        severity: "warn",
        payload: { type: "tool.failed", toolId, invocationId: invocationRow.id, errorCode, latencyMs },
      });
      void updateToolHealth(pool, toolId, isToolNotAvailable ? "unavailable" : "degraded", message);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Result metadata for the DB row and telemetry — sizes/counts, never a duplicate of the output payload itself. */
function summarizeOutput(output: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (typeof value === "string") meta[`${key}Length`] = value.length;
    else if (Array.isArray(value)) meta[`${key}Count`] = value.length;
  }
  return meta;
}
