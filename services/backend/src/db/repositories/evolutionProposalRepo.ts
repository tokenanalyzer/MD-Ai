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
 * Data-access layer only, for migration `0012_evolution_audit.sql`'s
 * `evolution_proposals` table. M8 wires Guardian's automatic policy review
 * onto rows in this table (docs/architecture/09-roadmap.md M8); nothing
 * here creates a proposal from a real discovery/benchmarking sweep or runs
 * sandbox testing — that producer pipeline is explicitly M9
 * (`core/evolution/README.md`). `createProposal` exists so Guardian's
 * review path is genuinely testable end-to-end against a real row, not so
 * this module is a proposal-authoring API.
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

export async function listProposals(pool: pg.Pool): Promise<EvolutionProposalRow[]> {
  const { rows } = await pool.query<EvolutionProposalRow>("SELECT * FROM evolution_proposals ORDER BY created_at DESC");
  return rows;
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
