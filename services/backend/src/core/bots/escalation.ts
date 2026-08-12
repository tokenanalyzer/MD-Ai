import type pg from "pg";
import type { AgentRegistry, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import type { ToolRegistryService } from "../mcp/toolRegistryService.js";
import type { BotFindingRow } from "../../db/repositories/botFindingRepo.js";
import { createTask, getTask } from "../../db/repositories/taskRepo.js";
import { buildBackgroundProviderKeys, buildBackgroundToolKeys } from "../../db/repositories/backgroundCredentialRepo.js";
import { decryptCredential } from "../security/backgroundKeyVault.js";
import { buildRuntimeContext } from "../agents/runtimeContext.js";

export interface EscalationDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistryService;
}

export interface EscalationResult {
  title: string;
  summary: string;
  taskId: string;
}

/**
 * M5.12: Bot → Finding → (importance filter already passed) → Master →
 * analysis → Reviewer when appropriate → notification. This dispatches
 * into the *exact same* entry point a user chat message uses
 * (`buildRuntimeContext` + `master.handleTask`) — Master does its own
 * intent classification and capability-based delegation via the Agent
 * Registry internally (M3), so there is no bot-specific routing table to
 * keep in sync and no way to bypass `agent_delegation_edges`/
 * `agent_tool_grants`. The only difference from the chat path is that
 * this call is awaited to completion (there's no WS client to stream to)
 * and its provider/tool credentials come from the opt-in background vault
 * instead of a live request body.
 *
 * Returns `undefined` — never throws for this reason — when no provider
 * has been opted into background use: a bot's own deterministic
 * title/summary is a perfectly valid notification on its own, and
 * "graceful when unconfigured" applies here exactly as it does to the
 * second SearchProvider (M5.0).
 */
export async function escalateFinding(deps: EscalationDeps, finding: BotFindingRow): Promise<EscalationResult | undefined> {
  const providerKeys = await buildBackgroundProviderKeys(deps.pool, decryptCredential);
  if (Object.keys(providerKeys).length === 0) return undefined;
  const toolKeys = await buildBackgroundToolKeys(deps.pool, decryptCredential);

  const master = await deps.agentRegistry.get("master");
  if (!master) return undefined;

  const currentUserText = buildEscalationPrompt(finding);
  const task = await createTask(deps.pool, {
    assignedAgentId: "master",
    taskType: "bot_escalation",
    inputPayload: {
      parts: [{ type: "text", text: currentUserText }],
      currentUserText,
      source: "bot",
      botId: finding.bot_id,
      findingId: finding.id,
    },
  });

  await deps.eventBus.publish({
    sourceType: "bot",
    sourceId: finding.bot_id,
    taskId: task.id,
    payload: { type: "task.created", taskId: task.id, assignedAgentId: "master", taskType: "bot_escalation" },
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

  try {
    await master.handleTask(ctx);
  } catch {
    // Failure is already persisted onto the task row and emitted as
    // task.failed/agent.failed by the runtime context — the caller
    // (core/bots/pipeline.ts) falls back to the bot's own deterministic
    // title/summary rather than losing the finding entirely.
    return undefined;
  }

  const finalRow = await getTask(deps.pool, task.id);
  if (!finalRow || finalRow.state !== "completed") return undefined;

  const output = finalRow.output as { text?: string } | null;
  const text = output?.text?.trim();
  if (!text) return undefined;

  return { title: finding.title, summary: text, taskId: task.id };
}

function buildEscalationPrompt(finding: BotFindingRow): string {
  return [
    `A background monitoring bot ("${finding.bot_id}") detected the following and needs it analyzed for a push notification.`,
    `Category: ${finding.category}`,
    `Title: ${finding.title}`,
    `Bot's own summary: ${finding.summary}`,
    `Detected at: ${finding.detected_at.toISOString()}`,
    "Write a short (2-4 sentence), factual notification summary grounded only in the information above. Do not invent details beyond what was reported.",
  ].join("\n");
}
