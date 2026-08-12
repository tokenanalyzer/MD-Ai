import type pg from "pg";
import type { AgentCard, AgentStatus } from "@mdai/shared-types";

export interface AgentRow {
  id: string;
  display_name: string;
  description: string;
  agent_card: AgentCard;
  capabilities: string[];
  is_internal: boolean;
  external_endpoint: string | null;
  status: AgentStatus;
  enabled: boolean;
  last_heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function listAgents(pool: pg.Pool): Promise<AgentRow[]> {
  const { rows } = await pool.query<AgentRow>("SELECT * FROM agents ORDER BY id");
  return rows;
}

export async function getAgent(pool: pg.Pool, id: string): Promise<AgentRow | undefined> {
  const { rows } = await pool.query<AgentRow>("SELECT * FROM agents WHERE id = $1", [id]);
  return rows[0];
}

export async function listAgentsByCapability(pool: pg.Pool, capability: string): Promise<AgentRow[]> {
  const { rows } = await pool.query<AgentRow>(
    "SELECT * FROM agents WHERE $1 = ANY(capabilities) AND enabled = true ORDER BY id",
    [capability],
  );
  return rows;
}

export async function setAgentEnabled(pool: pg.Pool, id: string, enabled: boolean): Promise<void> {
  await pool.query("UPDATE agents SET enabled = $2, updated_at = now() WHERE id = $1", [id, enabled]);
}

export async function recordAgentHeartbeat(pool: pg.Pool, id: string, status: AgentStatus): Promise<void> {
  await pool.query("UPDATE agents SET status = $2, last_heartbeat_at = now(), updated_at = now() WHERE id = $1", [
    id,
    status,
  ]);
}

export async function isDelegationAuthorized(pool: pg.Pool, fromAgentId: string, toAgentId: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM agent_delegation_edges WHERE from_agent_id = $1 AND to_agent_id = $2",
    [fromAgentId, toAgentId],
  );
  return rows.length > 0;
}

export async function getDelegationOptions(pool: pg.Pool, fromAgentId: string): Promise<AgentRow[]> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT a.* FROM agents a
     JOIN agent_delegation_edges e ON e.to_agent_id = a.id
     WHERE e.from_agent_id = $1 AND a.enabled = true
     ORDER BY a.id`,
    [fromAgentId],
  );
  return rows;
}
