/**
 * Bots are deterministic, non-LLM workers — see docs/architecture/
 * 12-bot-engine.md §1. Core pipeline (M5): BOT DETECTS → FINDING →
 * IMPORTANCE FILTER → AGENT ANALYSIS WHEN NEEDED → REVIEW WHEN NEEDED →
 * PUSH NOTIFICATION → USER. A `BotDefinition.run` never calls an LLM
 * directly — its only way to reach the agent world is by producing
 * `NormalizedFinding`s that `core/bots/escalation.ts` may later escalate
 * to Master, exactly like a user chat message would.
 */

export type BotCategory = "ai_release" | "news" | "user_topic" | "system_health" | "market" | "social" | "business" | "general";
export type BotStatus = "idle" | "running" | "paused" | "disabled" | "error";
export type BotHealth = "healthy" | "degraded" | "unavailable" | "unknown";
export type FindingImportance = "low" | "medium" | "high" | "critical";
export type FindingStatus = "new" | "escalated" | "notified" | "resolved" | "dismissed";
export type EscalationStatus = "none" | "pending" | "escalated" | "analyzed" | "failed";
export type BotRunStatus = "running" | "succeeded" | "failed" | "timeout" | "cancelled";

/** DB-backed descriptive/mutable metadata for a bot (M5.1) — the registry's source of truth, mirroring `ToolDefinition`/`AgentCard`. */
export interface BotDescriptor {
  id: string;
  displayName: string;
  description: string;
  version: string;
  category: BotCategory;
  status: BotStatus;
  scheduleCron: string;
  config: Record<string, unknown>;
  capabilities: string[];
  enabled: boolean;
  health: BotHealth;
  healthDetail?: string;
  lastRunAt?: string;
  lastSuccessfulRunAt?: string;
  failureCount: number;
  timeoutMs: number;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a bot actually reports — a signal, never a final AI answer (M5.4).
 * `dedupKey` must be a stable, deterministic identity for "this is the same
 * underlying thing" across repeated runs (e.g. a release version string, a
 * normalized article URL, a threshold-breach type) — the Bot Engine uses
 * `(botId, dedupKey)` to collapse repeated detections into one finding with
 * a bumped `occurrenceCount` instead of a notification per run (M5.5).
 */
export interface NormalizedFinding {
  category: string;
  title: string;
  summary: string;
  importance: FindingImportance;
  /** 0–1. A bot's own confidence in this detection — not an LLM confidence score, since bots never call an LLM. */
  confidence: number;
  sourceMetadata: Record<string, unknown>;
  /** Raw structured detection data, for the escalated Agent's context — never secrets, never a full raw response dump (M5.3). */
  payload: Record<string, unknown>;
  dedupKey: string;
}

export interface BotFinding extends NormalizedFinding {
  id: string;
  botId: string;
  botRunId: string;
  detectedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  cooldownUntil?: string;
  status: FindingStatus;
  escalationStatus: EscalationStatus;
  routedTaskId?: string;
}

export interface BotRunResult {
  status: "succeeded" | "failed";
  findings: NormalizedFinding[];
  error?: string;
  /** Resource/telemetry metadata a bot wants recorded on its run — counts, byte sizes, request counts. Never secrets, never raw response dumps (M5.3). */
  resourceMetadata?: Record<string, unknown>;
}

export interface BotRun {
  id: string;
  botId: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: BotRunStatus;
  error?: string;
  errorCode?: string;
  findingsCount: number;
  resourceMetadata: Record<string, unknown>;
}

/**
 * What a bot's `run` receives — deliberately far narrower than
 * `AgentRuntimeContext`: no `selectModel`/`completeChat`/`delegate`. A bot
 * that needs a search provider goes through `callSearchProvider`, which
 * resolves a key exactly like `web_search` does (request-scoped `toolKeys`
 * when available, falling back to the opt-in background credential vault —
 * see `docs/architecture/07-security-model.md` §3.4/§12 — when running
 * unattended); it never gets a raw key handed to it directly.
 */
export interface BotRunContext {
  botId: string;
  config: Record<string, unknown>;
  signal: AbortSignal;
  callSearchProvider(query: string, maxResults?: number): Promise<{ results: import("../mcp/index.js").SearchResultItem[]; provider: string } | undefined>;
}

export interface BotDefinition {
  id: string;
  displayName: string;
  description: string;
  version: string;
  category: BotCategory;
  scheduleCron: string;
  /** Bot-specific parameters (topics, sources, thresholds) — validated by the bot's own logic, not generic. */
  defaultConfig: Record<string, unknown>;
  capabilities: string[];
  timeoutMs: number;
  run(ctx: BotRunContext): Promise<BotRunResult>;
}

export interface BotRegistry {
  list(): Promise<BotDescriptor[]>;
  get(botId: string): Promise<BotDescriptor | undefined>;
  register(bot: BotDefinition): void;
  getImplementation(botId: string): BotDefinition | undefined;
  setEnabled(botId: string, enabled: boolean): Promise<void>;
  setPaused(botId: string, paused: boolean): Promise<void>;
}

export interface BotEngine {
  runNow(botId: string): Promise<BotRun>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
