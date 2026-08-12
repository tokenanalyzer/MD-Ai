import type { FindingImportance } from "@mdai/shared-types";

/** M5.6: a fixed, deterministic ranking — never inferred, never LLM-scored. */
const IMPORTANCE_RANK: Record<FindingImportance, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function meetsImportanceThreshold(importance: FindingImportance, threshold: FindingImportance): boolean {
  return IMPORTANCE_RANK[importance] >= IMPORTANCE_RANK[threshold];
}

/** The deterministic gate before any LLM call (M5.6) — findings below this never trigger Agent analysis, only their own bot-authored title/summary. */
export const ESCALATION_MIN_IMPORTANCE: FindingImportance = "medium";

/**
 * M5.5: how long a repeat detection of the same `(botId, dedupKey)` is
 * silently absorbed (occurrence_count bump only, no re-escalation/
 * re-notification) after the finding was last acted on. Higher importance
 * gets a *shorter* cooldown — a still-unresolved CRITICAL system-health
 * breach is worth re-surfacing sooner than a LOW-importance news item —
 * but every level is well past "a bot polling every few minutes," which is
 * what actually prevents a 12-hour-visible release from producing 12
 * notifications.
 */
const COOLDOWN_MS: Record<FindingImportance, number> = {
  critical: 60 * 60 * 1000, // 1h
  high: 6 * 60 * 60 * 1000, // 6h
  medium: 24 * 60 * 60 * 1000, // 24h
  low: 72 * 60 * 60 * 1000, // 72h
};

export function cooldownUntilFor(importance: FindingImportance, now: Date = new Date()): Date {
  return new Date(now.getTime() + COOLDOWN_MS[importance]);
}

export function isUnderCooldown(cooldownUntil: Date | null, now: Date = new Date()): boolean {
  return cooldownUntil !== null && cooldownUntil.getTime() > now.getTime();
}
