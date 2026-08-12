import type pg from "pg";

export type EvolutionChangeClass =
  | "knowledge_update"
  | "model_registry_update"
  | "routing_policy_update"
  | "skill_update"
  | "application_code_update";

export type EvolutionProposalStatus = "proposed" | "sandbox_tested" | "approved" | "rejected" | "applied" | "rolled_back";

export interface EvolutionProposalRow {
  id: string;
  change_class: EvolutionChangeClass;
  title: string;
  rationale: string;
  diff: Record<string, unknown>;
  risk_level: "low" | "medium" | "high";
  requires_approval: boolean;
  status: EvolutionProposalStatus;
  sandbox_result: Record<string, unknown> | null;
  decided_by: "user" | "auto" | null;
  decided_at: Date | null;
  applied_at: Date | null;
  rolled_back_at: Date | null;
  created_at: Date;
}

/**
 * Data-access layer for migration `0012_evolution_audit.sql`'s
 * `evolution_proposals` table. M8 wired Guardian's automatic policy review
 * onto rows here; M9 adds the real producer pipeline
 * (`core/evolution/discoverySweep.ts`/`benchmarking.ts` create rows via
 * `createProposal`), sandbox testing (`recordSandboxResult`), and applying
 * (`markApplied`) — see `core/evolution/README.md`. No function here ever
 * writes `status = 'approved'` except `decideProposal`, and only when
 * called with a human-originated decision (`api/routes/evolution.ts`) —
 * the sweep producer and Guardian both go through `applyGuardianVerdict`/
 * `markApplied`, neither of which can produce `approved`.
 */
export async function createProposal(
  pool: pg.Pool,
  input: {
    changeClass: EvolutionChangeClass;
    title: string;
    rationale: string;
    diff: Record<string, unknown>;
    riskLevel: "low" | "medium" | "high";
    requiresApproval: boolean;
  },
): Promise<EvolutionProposalRow> {
  const { rows } = await pool.query<EvolutionProposalRow>(
    `INSERT INTO evolution_proposals (change_class, title, rationale, diff, risk_level, requires_approval)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.changeClass, input.title, input.rationale, input.diff, input.riskLevel, input.requiresApproval],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create evolution proposal");
  return row;
}

export async function getProposal(pool: pg.Pool, id: string): Promise<EvolutionProposalRow | undefined> {
  const { rows } = await pool.query<EvolutionProposalRow>("SELECT * FROM evolution_proposals WHERE id = $1", [id]);
  return rows[0];
}

export async function listProposals(pool: pg.Pool, status?: EvolutionProposalStatus): Promise<EvolutionProposalRow[]> {
  if (status) {
    const { rows } = await pool.query<EvolutionProposalRow>(
      "SELECT * FROM evolution_proposals WHERE status = $1 ORDER BY created_at DESC",
      [status],
    );
    return rows;
  }
  const { rows } = await pool.query<EvolutionProposalRow>("SELECT * FROM evolution_proposals ORDER BY created_at DESC");
  return rows;
}

/** M9: records a sandbox-test outcome (`core/evolution/sandbox.ts` — a real, always-rolled-back transaction, not a fabricated pass) and advances `proposed` → `sandbox_tested`. Only transitions rows still `proposed`, so a sandbox test can't be recorded twice or overwrite a Guardian denial. */
export async function recordSandboxResult(
  pool: pg.Pool,
  id: string,
  sandboxResult: Record<string, unknown>,
): Promise<EvolutionProposalRow | undefined> {
  const { rows } = await pool.query<EvolutionProposalRow>(
    `UPDATE evolution_proposals SET status = 'sandbox_tested', sandbox_result = $2 WHERE id = $1 AND status = 'proposed' RETURNING *`,
    [id, sandboxResult],
  );
  return rows[0];
}

/** M9: records that a proposal was actually applied (`core/evolution/applyProposal.ts`) — either auto-applied by the sweep producer (no `decided_by`, since it was never gated behind a human decision) or applied after a human's explicit approval. Only transitions rows that are `sandbox_tested` or already `approved`. */
export async function markApplied(
  pool: pg.Pool,
  id: string,
  resultMetadata?: Record<string, unknown>,
): Promise<EvolutionProposalRow | undefined> {
  const { rows } = await pool.query<EvolutionProposalRow>(
    `UPDATE evolution_proposals SET status = 'applied', applied_at = now(),
        sandbox_result = COALESCE($2, sandbox_result)
     WHERE id = $1 AND status IN ('sandbox_tested', 'approved') RETURNING *`,
    [id, resultMetadata ?? null],
  );
  return rows[0];
}

/** Guardian's automatic verdict: `deny` sets `rejected`/`decided_by='auto'`; `pending` leaves the row exactly as `proposed` for a human. Guardian can never write `approved` — enforced here by simply never accepting it as an argument. */
export async function applyGuardianVerdict(
  pool: pg.Pool,
  id: string,
  verdict: { decision: "deny" | "pending" },
): Promise<EvolutionProposalRow> {
  if (verdict.decision === "pending") {
    const row = await getProposal(pool, id);
    if (!row) throw new Error(`Evolution proposal ${id} not found`);
    return row;
  }
  const { rows } = await pool.query<EvolutionProposalRow>(
    `UPDATE evolution_proposals SET status = 'rejected', decided_by = 'auto', decided_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`Evolution proposal ${id} not found`);
  return row;
}

/** A human's decision on a proposal Guardian did not already veto. */
export async function decideProposal(
  pool: pg.Pool,
  id: string,
  decision: "approved" | "rejected",
): Promise<EvolutionProposalRow> {
  const { rows } = await pool.query<EvolutionProposalRow>(
    `UPDATE evolution_proposals SET status = $2, decided_by = 'user', decided_at = now() WHERE id = $1 RETURNING *`,
    [id, decision],
  );
  const row = rows[0];
  if (!row) throw new Error(`Evolution proposal ${id} not found`);
  return row;
}
