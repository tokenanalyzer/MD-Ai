import type pg from "pg";
import type { Agent, AgentCard, AgentRegistry, AgentStatus } from "@mdai/shared-types";
import {
  getAgent,
  getDelegationOptions as getDelegationOptionsRepo,
  isDelegationAuthorized as isDelegationAuthorizedRepo,
  listAgents,
  listAgentsByCapability,
  recordAgentHeartbeat,
  setAgentEnabled,
  type AgentRow,
} from "../../db/repositories/agentRepo.js";

function toCard(row: AgentRow): AgentCard {
  // agent_card JSONB is the source of truth for descriptive fields
  // (capabilities, description, model/tool preferences); status and
  // last_heartbeat_at have their own dedicated columns because they
  // change far more often and shouldn't require rewriting the whole
  // JSON blob on every heartbeat.
  return {
    ...row.agent_card,
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    isInternal: row.is_internal,
    externalEndpoint: row.external_endpoint ?? undefined,
    status: row.enabled ? row.status : "disabled",
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString(),
  };
}

/**
 * DB-backed Agent Registry (M3.1). `agents` (DB) holds every known agent's
 * card/status/authorization data, even ones this process hasn't loaded an
 * implementation for; the in-process `Map` holds only the ones actually
 * registered by `index.ts` at boot. `get()` only returns from the map —
 * you can't dispatch a task to an agent whose code isn't running here.
 */
export class AgentRegistryService implements AgentRegistry {
  private readonly implementations = new Map<string, Agent>();

  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<AgentCard[]> {
    const rows = await listAgents(this.pool);
    return rows.map(toCard);
  }

  async get(agentId: string): Promise<Agent | undefined> {
    return this.implementations.get(agentId);
  }

  register(agent: Agent): void {
    this.implementations.set(agent.card.id, agent);
  }

  async setEnabled(agentId: string, enabled: boolean): Promise<void> {
    await setAgentEnabled(this.pool, agentId, enabled);
  }

  async getDelegationOptions(agentId: string): Promise<AgentCard[]> {
    const rows = await getDelegationOptionsRepo(this.pool, agentId);
    return rows.map(toCard);
  }

  async isDelegationAuthorized(fromAgentId: string, toAgentId: string): Promise<boolean> {
    return isDelegationAuthorizedRepo(this.pool, fromAgentId, toAgentId);
  }

  async findByCapability(capability: string): Promise<AgentCard[]> {
    const rows = await listAgentsByCapability(this.pool, capability);
    // Only agents this process can actually dispatch to are useful
    // discovery results — an enabled-in-DB agent with no loaded
    // implementation would fail immediately on delegate().
    return rows.filter((r) => this.implementations.has(r.id)).map(toCard);
  }

  async recordHeartbeat(agentId: string, status: AgentStatus): Promise<void> {
    await recordAgentHeartbeat(this.pool, agentId, status);
  }

  /** Convenience for callers that already have a DB row and want the merged card without a second query. */
  async getCard(agentId: string): Promise<AgentCard | undefined> {
    const row = await getAgent(this.pool, agentId);
    return row ? toCard(row) : undefined;
  }
}
