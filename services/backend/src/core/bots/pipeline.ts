import type pg from "pg";
import type { AgentRegistry, ModelRegistry, NormalizedFinding } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import type { ToolRegistryService } from "../mcp/toolRegistryService.js";
import type { NotificationSender } from "@mdai/shared-types";
import {
  setFindingCooldown,
  setFindingEscalationStatus,
  setFindingStatus,
  upsertFinding,
} from "../../db/repositories/botFindingRepo.js";
import { cooldownUntilFor, isUnderCooldown, meetsImportanceThreshold, ESCALATION_MIN_IMPORTANCE } from "./dedup.js";
import { escalateFinding } from "./escalation.js";
import { notifyForFinding } from "../notifications/notificationService.js";

export interface PipelineDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistryService;
  ownerId: string;
  notificationSender: NotificationSender;
}

/**
 * The BOT DETECTS → FINDING → IMPORTANCE FILTER → AGENT ANALYSIS WHEN
 * NEEDED → REVIEW WHEN NEEDED → PUSH NOTIFICATION → USER pipeline (M5's
 * core principle), run once per finding a bot's `run()` reported. Returns
 * the count of genuinely new findings (for the `bot.run.completed`
 * event's `findingsCount`) — repeat detections absorbed by dedup still
 * update `occurrence_count` but don't count as "new."
 */
export async function processBotFindings(
  deps: PipelineDeps,
  botId: string,
  botRunId: string,
  findings: NormalizedFinding[],
): Promise<number> {
  let newCount = 0;

  for (const finding of findings) {
    const { row, isNewFinding } = await upsertFinding(deps.pool, { botId, botRunId, finding });
    if (isNewFinding) newCount++;

    await deps.eventBus.publish({
      sourceType: "bot",
      sourceId: botId,
      payload: isNewFinding
        ? { type: "bot.finding.created", botId, botRunId, findingId: row.id, category: row.category, importance: row.importance }
        : { type: "bot.finding.deduplicated", botId, findingId: row.id, occurrenceCount: row.occurrence_count },
    });

    // M5.5: a repeat detection still under its cooldown window is fully
    // absorbed here — no escalation, no notification, nothing further.
    if (!isNewFinding && isUnderCooldown(row.cooldown_until)) continue;

    let title = row.title;
    let summary = row.summary;

    // M5.6: deterministic importance gate, evaluated before any LLM call.
    if (meetsImportanceThreshold(row.importance, ESCALATION_MIN_IMPORTANCE)) {
      await setFindingEscalationStatus(deps.pool, row.id, "pending");
      try {
        const result = await escalateFinding(deps, row);
        if (result) {
          title = result.title;
          summary = result.summary;
          await setFindingEscalationStatus(deps.pool, row.id, "analyzed", result.taskId);
          await setFindingStatus(deps.pool, row.id, "escalated");
          await deps.eventBus.publish({
            sourceType: "bot",
            sourceId: botId,
            payload: { type: "bot.finding.escalated", botId, findingId: row.id, routedTaskId: result.taskId },
          });
        } else {
          // No provider opted into background use, or Master had nothing
          // useful to add — proceed with the bot's own deterministic
          // content rather than losing the finding.
          await setFindingEscalationStatus(deps.pool, row.id, "none");
        }
      } catch {
        await setFindingEscalationStatus(deps.pool, row.id, "failed");
      }
    }

    await notifyForFinding(
      { pool: deps.pool, eventBus: deps.eventBus, ownerId: deps.ownerId, sender: deps.notificationSender },
      {
        findingId: row.id,
        botId,
        category: row.category,
        title,
        summary,
        importance: row.importance,
        deepLink: `mdai://findings/${row.id}`,
      },
    );

    await setFindingStatus(deps.pool, row.id, "notified");
    await setFindingCooldown(deps.pool, row.id, cooldownUntilFor(row.importance));
  }

  return newCount;
}
