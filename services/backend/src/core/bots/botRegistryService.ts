import type pg from "pg";
import type { BotDefinition, BotDescriptor, BotRegistry } from "@mdai/shared-types";
import { getBot, listBots, setBotEnabled, setBotPaused, type BotRow } from "../../db/repositories/botRepo.js";

function toDescriptor(row: BotRow): BotDescriptor {
  return {
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    version: row.version,
    category: row.category,
    status: row.status,
    scheduleCron: row.schedule_cron,
    config: row.config,
    capabilities: row.capabilities,
    enabled: row.enabled,
    health: row.health,
    healthDetail: row.health_detail ?? undefined,
    lastRunAt: row.last_run_at?.toISOString(),
    lastSuccessfulRunAt: row.last_successful_run_at?.toISOString(),
    failureCount: row.failure_count,
    timeoutMs: row.timeout_ms,
    owner: row.owner,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * DB-backed Bot Registry (M5.1), mirroring `AgentRegistryService`/
 * `ToolRegistryService`'s split exactly: `bots` (DB) is the source of
 * truth for every bot's descriptive/mutable metadata (status, health,
 * last run, failure count — things that change independent of code),
 * while the in-process `Map` holds only the `BotDefinition`
 * implementations this process actually registered at boot in `index.ts`.
 * No hardcoded bot list anywhere in the scheduler — `core/bots/botEngine.ts`
 * only ever dispatches to what's in this map, and only for bots this
 * table also marks `enabled`.
 */
export class BotRegistryService implements BotRegistry {
  private readonly implementations = new Map<string, BotDefinition>();

  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<BotDescriptor[]> {
    const rows = await listBots(this.pool);
    return rows.map(toDescriptor);
  }

  async get(botId: string): Promise<BotDescriptor | undefined> {
    const row = await getBot(this.pool, botId);
    return row ? toDescriptor(row) : undefined;
  }

  register(bot: BotDefinition): void {
    this.implementations.set(bot.id, bot);
  }

  getImplementation(botId: string): BotDefinition | undefined {
    return this.implementations.get(botId);
  }

  async setEnabled(botId: string, enabled: boolean): Promise<void> {
    await setBotEnabled(this.pool, botId, enabled);
  }

  async setPaused(botId: string, paused: boolean): Promise<void> {
    await setBotPaused(this.pool, botId, paused);
  }
}
