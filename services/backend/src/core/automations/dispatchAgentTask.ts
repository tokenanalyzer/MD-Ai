import type pg from "pg";
import type { AgentRegistry, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import type { ToolRegistryService } from "../mcp/toolRegistryService.js";
import type { AutomationRow } from "../../db/repositories/automationRepo.js";
import { createTask, getTask } from "../../db/repositories/taskRepo.js";
import { buildBackgroundProviderKeys, buildBackgroundToolKeys } from "../../db/repositories/backgroundCredentialRepo.js";
import { decryptCredential } from "../security/backgroundKeyVault.js";
import { buildRuntimeContext } from "../agents/runtimeContext.js";

export interface DispatchAgentTaskDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistryService;
}

export interface DispatchAgentTaskResult {
  taskId: string;
  text: string;
}

/**
 * M10 `action_type = 'agent_task'`: dispatches into the *exact same* entry
 * point a user chat message and a bot escalation (`core/bots/
 * escalation.ts`, M5.12) already use — `buildRuntimeContext` +
 * `master.handleTask`. This is the load-bearing safety property for
 * externally-triggered automations (webhook-triggered ones especially):
 * Master does its own intent classification and capability-based
 * delegation via the Agent Registry internally, so there is no
 * automation-specific routing table that could diverge from
 * `agent_delegation_edges`/`agent_tool_grants`, and any tool call Master's
 * delegates make still goes through `mcpHost.invokeTool`'s Guardian gate
 * exactly like a chat-originated call — an automation cannot reach a tool
 * or capability a normal chat message couldn't.
 *
 * Credentials come from the opt-in background vault (M5.12a), never a
 * live request body — an automation has no per-request caller to supply
 * one, same reasoning as bot escalation.
 */
export async function dispatchAgentTask(
  deps: DispatchAgentTaskDeps,
  automation: AutomationRow,
  automationRunId: string,
): Promise<DispatchAgentTaskResult | undefined> {
  const providerKeys = await buildBackgroundProviderKeys(deps.pool, decryptCredential);
  if (Object.keys(providerKeys).length === 0) return undefined;
  const toolKeys = await buildBackgroundToolKeys(deps.pool, decryptCredential);

  const master = await deps.agentRegistry.get("master");
  if (!master) return undefined;

  const prompt = typeof automation.action_config["prompt"] === "string" ? (automation.action_config["prompt"] as string) : undefined;
  if (!prompt) return undefined;

  const task = await createTask(deps.pool, {
    assignedAgentId: "master",
    taskType: "automation_run",
    inputPayload: {
      parts: [{ type: "text", text: prompt }],
      currentUserText: prompt,
      source: "automation",
      automationId: automation.id,
      automationRunId,
    },
  });

  await deps.eventBus.publish({
    sourceType: "automation",
    sourceId: automation.id,
    taskId: task.id,
    payload: { type: "task.created", taskId: task.id, assignedAgentId: "master", taskType: "automation_run" },
  });

  const ctx = await buildRuntimeContext(
    {
      pool: deps.pool,
      eventBus: deps.eventBus,
      modelRegistry: deps.modelRegistry,
      agentRegistry: deps.agentRegistry,
      toolRegistry: deps.toolRegistry,
      providerKeys,
      toolKeys,
      rootTaskId: task.id,
    },
    task,
    "master",
  );

  await master.handleTask(ctx);

  const finalRow = await getTask(deps.pool, task.id);
  if (!finalRow || finalRow.state !== "completed") {
    throw new Error(`Automation task ${task.id} did not complete successfully (state: ${finalRow?.state ?? "missing"})`);
  }

  const output = finalRow.output as { text?: string } | null;
  return { taskId: task.id, text: output?.text?.trim() ?? "" };
}
