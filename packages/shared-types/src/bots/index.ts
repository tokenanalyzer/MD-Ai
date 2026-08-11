/**
 * Bots are deterministic, non-LLM workers. This contract deliberately has
 * no `selectModel`/`callTool`-style hooks into the agent world — a bot's
 * only way to reach an agent is by producing a BotFinding that the Bot
 * Engine escalates, per the Bot → Agent → Reviewer → Master pipeline.
 */

export interface BotFinding {
  id: string;
  botId: string;
  botRunId: string;
  severity: "info" | "warn" | "critical";
  payload: Record<string, unknown>;
  routedTaskId?: string;
  createdAt: string;
}

export interface BotRunResult {
  status: "succeeded" | "failed";
  findings: Omit<BotFinding, "id" | "botRunId" | "createdAt">[];
  error?: string;
}

export interface BotDefinition {
  id: string;
  displayName: string;
  description: string;
  scheduleCron: string;
  /** Bot-specific parameters (symbols, thresholds, feed URLs) — validated by the bot's own schema, not generic. */
  config: Record<string, unknown>;
  /** Agent that receives escalated findings, e.g. "crypto-intel" for a price-monitor watching crypto pairs. */
  escalateToAgentId?: string;
  run(config: Record<string, unknown>): Promise<BotRunResult>;
}

export interface BotEngine {
  list(): Promise<BotDefinition[]>;
  register(bot: BotDefinition): void;
  runNow(botId: string): Promise<BotRunResult>;
  setEnabled(botId: string, enabled: boolean): Promise<void>;
}
