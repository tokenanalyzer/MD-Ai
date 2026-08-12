import type { EventDto } from "../api/client";

/**
 * Turns a typed event's `type` + safe payload fields into one
 * human-readable line — never chain-of-thought, never a raw payload dump
 * (docs/architecture/05-event-schemas.md). Kept in its own dependency-free
 * module (no react-native/expo imports) so it stays covered by this
 * repo's plain-Node vitest suite (see test/describeEvent.test.ts and
 * vitest.config.ts's "no RN runtime" comment) — EventRow.tsx re-exports
 * it for the one component that renders it.
 */
export function describeEvent(event: EventDto): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "agent.started":
      return `${p["agentId"]} started`;
    case "agent.completed":
      return `${p["agentId"]} completed in ${p["durationMs"]}ms`;
    case "agent.failed":
      return `${p["agentId"]} failed: ${p["errorCode"]}`;
    case "task.created":
      return `Task created for ${p["assignedAgentId"]}`;
    case "task.completed":
      return `Task completed (${p["durationMs"]}ms)`;
    case "task.failed":
      return `Task failed: ${p["errorCode"]}`;
    case "message.sent":
      return `${p["fromAgentId"]} → ${p["toAgentId"]}`;
    case "review.completed":
      return `Review: ${p["decision"]}`;
    case "memory.created":
      return `Memory created (${p["category"]})`;
    case "memory.retrieved":
      return `${p["count"]} memories retrieved`;
    case "tool.called":
      return `Tool called: ${p["toolId"]}`;
    case "tool.completed":
      return `Tool ${p["toolId"] ?? ""} completed: ${p["status"]}`;
    case "tool.failed":
      return `Tool failed: ${p["errorCode"]}`;
    case "tool.blocked":
      return `Tool blocked: ${p["reason"]}`;
    case "model.selected":
      return `Model selected: ${p["modelId"]}`;
    case "model.switched":
      return `Model switched: ${p["fromModelId"]} → ${p["toModelId"]}`;
    case "bot.run.completed":
      return `${p["botId"]} run ${p["status"]} (${p["findingsCount"]} finding(s))`;
    case "bot.failed":
      return `${p["botId"]} failed: ${p["message"]}`;
    case "bot.finding.created":
      return `${p["botId"]}: new ${p["importance"]} finding`;
    case "bot.finding.escalated":
      return `${p["botId"]}: finding escalated to Master`;
    case "bot.notification.sent":
      return "Notification sent";
    default:
      return event.type;
  }
}
