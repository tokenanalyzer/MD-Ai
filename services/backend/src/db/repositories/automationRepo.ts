import type pg from "pg";

export type AutomationTriggerType = "schedule" | "event" | "webhook" | "manual";
export type AutomationActionType = "agent_task" | "n8n_workflow" | "notification";

export interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  action_type: AutomationActionType;
  action_config: Record<string, unknown>;
  enabled: boolean;
  created_by: "user" | "master_agent";
  last_run_at: Date | null;
  webhook_slug: string | null;
  timeout_ms: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Data-access layer for migration `0011_automations.sql` (M0) +
 * `0022_m10_automations_openclaw.sql` (M10's `webhook_slug`/`timeout_ms`
 * additions) — see `docs/architecture/03-api-contracts.md` §7 and
 * `core/automations/README.md`.
 */
export async function createAutomation(
  pool: pg.Pool,
  input: {
    name: string;
    description?: string;
    triggerType: AutomationTriggerType;
    triggerConfig?: Record<string, unknown>;
    actionType: AutomationActionType;
    actionConfig?: Record<string, unknown>;
    createdBy?: "user" | "master_agent";
    timeoutMs?: number;
    webhookSlug?: string;
  },
): Promise<AutomationRow> {
  const { rows } = await pool.query<AutomationRow>(
    `INSERT INTO automations (name, description, trigger_type, trigger_config, action_type, action_config, created_by, timeout_ms, webhook_slug)
     VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb), $5, COALESCE($6::jsonb, '{}'::jsonb), COALESCE($7::text, 'user'), COALESCE($8::int, 30000), $9)
     RETURNING *`,
    [
      input.name,
      input.description ?? null,
      input.triggerType,
      input.triggerConfig ?? null,
      input.actionType,
      input.actionConfig ?? null,
      input.createdBy ?? null,
      input.timeoutMs ?? null,
      input.webhookSlug ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create automation");
  return row;
}

export async function listAutomations(pool: pg.Pool): Promise<AutomationRow[]> {
  const { rows } = await pool.query<AutomationRow>("SELECT * FROM automations ORDER BY created_at DESC");
  return rows;
}

export async function listEnabledAutomations(pool: pg.Pool, triggerType?: AutomationTriggerType): Promise<AutomationRow[]> {
  if (triggerType) {
    const { rows } = await pool.query<AutomationRow>(
      "SELECT * FROM automations WHERE enabled = true AND trigger_type = $1 ORDER BY id",
      [triggerType],
    );
    return rows;
  }
  const { rows } = await pool.query<AutomationRow>("SELECT * FROM automations WHERE enabled = true ORDER BY id");
  return rows;
}

export async function getAutomation(pool: pg.Pool, id: string): Promise<AutomationRow | undefined> {
  const { rows } = await pool.query<AutomationRow>("SELECT * FROM automations WHERE id = $1", [id]);
  return rows[0];
}

export async function getAutomationByWebhookSlug(pool: pg.Pool, slug: string): Promise<AutomationRow | undefined> {
  const { rows } = await pool.query<AutomationRow>("SELECT * FROM automations WHERE webhook_slug = $1", [slug]);
  return rows[0];
}

export async function updateAutomation(
  pool: pg.Pool,
  id: string,
  patch: { name?: string; description?: string; triggerConfig?: Record<string, unknown>; actionConfig?: Record<string, unknown>; enabled?: boolean },
): Promise<AutomationRow | undefined> {
  const { rows } = await pool.query<AutomationRow>(
    `UPDATE automations SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       trigger_config = COALESCE($4::jsonb, trigger_config),
       action_config = COALESCE($5::jsonb, action_config),
       enabled = COALESCE($6, enabled),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.description ?? null, patch.triggerConfig ?? null, patch.actionConfig ?? null, patch.enabled ?? null],
  );
  return rows[0];
}

export async function deleteAutomation(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("DELETE FROM automations WHERE id = $1", [id]);
}

export async function markAutomationRan(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("UPDATE automations SET last_run_at = now() WHERE id = $1", [id]);
}
