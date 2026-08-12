import type pg from "pg";
import type { JsonSchema, ToolAccessLevel, ToolHealth, ToolInvocationStatus, ToolRiskLevel } from "@mdai/shared-types";

export interface ToolRow {
  id: string;
  display_name: string;
  description: string;
  version: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  source: "builtin" | "mcp_server";
  mcp_server_url: string | null;
  mcp_metadata: Record<string, unknown>;
  required_capabilities: string[];
  risk_level: ToolRiskLevel;
  requires_approval: boolean;
  default_access: ToolAccessLevel;
  enabled: boolean;
  health: ToolHealth;
  health_detail: string | null;
  timeout_ms: number;
  last_verified_at: Date | null;
  owner: string;
  created_at: Date;
}

export async function listTools(pool: pg.Pool): Promise<ToolRow[]> {
  const { rows } = await pool.query<ToolRow>("SELECT * FROM tools ORDER BY id");
  return rows;
}

export async function getTool(pool: pg.Pool, id: string): Promise<ToolRow | undefined> {
  const { rows } = await pool.query<ToolRow>("SELECT * FROM tools WHERE id = $1", [id]);
  return rows[0];
}

/** `null` means no `agent_tool_grants` row — denied by omission (same pattern as `agent_delegation_edges`). */
export async function checkToolPermission(pool: pg.Pool, agentId: string, toolId: string): Promise<ToolAccessLevel | null> {
  const { rows } = await pool.query<{ permission_level: ToolAccessLevel }>(
    "SELECT permission_level FROM agent_tool_grants WHERE agent_id = $1 AND tool_id = $2",
    [agentId, toolId],
  );
  return rows[0]?.permission_level ?? null;
}

export async function updateToolHealth(
  pool: pg.Pool,
  toolId: string,
  health: ToolHealth,
  detail?: string,
): Promise<void> {
  await pool.query(
    "UPDATE tools SET health = $2, health_detail = $3, last_verified_at = now() WHERE id = $1",
    [toolId, health, detail ?? null],
  );
}

export interface ToolInvocationRow {
  id: string;
  tool_id: string;
  task_id: string | null;
  agent_id: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: ToolInvocationStatus;
  error: string | null;
  error_code: string | null;
  result_metadata: Record<string, unknown> | null;
  latency_ms: number | null;
  created_at: Date;
  completed_at: Date | null;
}

export async function createToolInvocation(
  pool: pg.Pool,
  input: { toolId: string; taskId?: string; agentId: string; input: Record<string, unknown> },
): Promise<ToolInvocationRow> {
  const { rows } = await pool.query<ToolInvocationRow>(
    `INSERT INTO tool_invocations (tool_id, task_id, agent_id, input, status)
     VALUES ($1, $2, $3, $4, 'running') RETURNING *`,
    [input.toolId, input.taskId ?? null, input.agentId, input.input],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create tool invocation");
  return row;
}

export async function getToolInvocation(pool: pg.Pool, id: string): Promise<ToolInvocationRow | undefined> {
  const { rows } = await pool.query<ToolInvocationRow>("SELECT * FROM tool_invocations WHERE id = $1", [id]);
  return rows[0];
}

export async function listToolInvocationsByStatus(
  pool: pg.Pool,
  status: ToolInvocationStatus,
  limit = 50,
): Promise<ToolInvocationRow[]> {
  const { rows } = await pool.query<ToolInvocationRow>(
    "SELECT * FROM tool_invocations WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
    [status, limit],
  );
  return rows;
}

/**
 * M8: a human's decision on an invocation Guardian left `awaiting_approval`
 * — records the decision only; no task-resumption mechanism exists to
 * replay/re-execute the original tool call (same documented boundary as
 * A2A cancellation being best-effort). Only transitions rows still
 * `awaiting_approval`, so a decision can't be applied twice or to a row
 * Guardian already denied.
 */
export async function decideToolInvocation(
  pool: pg.Pool,
  id: string,
  decision: "approved" | "denied",
): Promise<ToolInvocationRow | undefined> {
  const { rows } = await pool.query<ToolInvocationRow>(
    `UPDATE tool_invocations SET status = $2 WHERE id = $1 AND status = 'awaiting_approval' RETURNING *`,
    [id, decision],
  );
  return rows[0];
}

export async function completeToolInvocation(
  pool: pg.Pool,
  id: string,
  patch: {
    status: ToolInvocationStatus;
    output?: Record<string, unknown>;
    error?: string;
    errorCode?: string;
    resultMetadata?: Record<string, unknown>;
    latencyMs: number;
  },
): Promise<ToolInvocationRow> {
  const { rows } = await pool.query<ToolInvocationRow>(
    `UPDATE tool_invocations SET
       status = $2, output = $3, error = $4, error_code = $5,
       result_metadata = $6, latency_ms = $7, completed_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.status, patch.output ?? null, patch.error ?? null, patch.errorCode ?? null, patch.resultMetadata ?? null, patch.latencyMs],
  );
  const row = rows[0];
  if (!row) throw new Error(`Tool invocation ${id} not found`);
  return row;
}
