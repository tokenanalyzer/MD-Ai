import type pg from "pg";
import type { MemoryApprovalStatus, MemoryCategory } from "@mdai/shared-types";

export interface MemoryRow {
  id: string;
  category: MemoryCategory;
  content: string;
  summary: string | null;
  source: string;
  source_task_id: string | null;
  confidence: string; // NUMERIC comes back as string
  importance: string;
  tags: string[];
  pinned: boolean;
  approval_status: MemoryApprovalStatus;
  superseded_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface InsertMemoryInput {
  category: MemoryCategory;
  content: string;
  summary?: string;
  source: string;
  sourceTaskId?: string;
  confidence?: number;
  importance?: number;
  tags?: string[];
  pinned?: boolean;
  approvalStatus?: MemoryApprovalStatus;
}

export async function insertMemory(pool: pg.Pool, input: InsertMemoryInput): Promise<MemoryRow> {
  const { rows } = await pool.query<MemoryRow>(
    `INSERT INTO memory_items (category, content, summary, source, source_task_id, confidence, importance, tags, pinned, approval_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      input.category,
      input.content,
      input.summary ?? null,
      input.source,
      input.sourceTaskId ?? null,
      input.confidence ?? 1.0,
      input.importance ?? 0.5,
      input.tags ?? [],
      input.pinned ?? false,
      input.approvalStatus ?? "approved",
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to insert memory item");
  return row;
}

export async function getMemory(pool: pg.Pool, id: string): Promise<MemoryRow | undefined> {
  const { rows } = await pool.query<MemoryRow>("SELECT * FROM memory_items WHERE id = $1 AND deleted_at IS NULL", [id]);
  return rows[0];
}

export interface SearchMemoryInput {
  query?: string;
  category?: MemoryCategory;
  topK?: number;
}

/**
 * Lexical/trigram-ranked retrieval (docs/architecture/06 §... memory
 * design note: real cross-vendor embedding generation is deferred, not
 * faked — `pg_trgm` similarity + importance/confidence/pinned weighting
 * gives genuinely useful ranking without it). Only ever returns
 * `approval_status = 'approved'`, non-deleted memories — a pending
 * candidate is invisible to retrieval until approved.
 */
export async function searchMemory(pool: pg.Pool, input: SearchMemoryInput): Promise<MemoryRow[]> {
  const topK = input.topK ?? 5;
  const params: unknown[] = [];
  const conditions = ["deleted_at IS NULL", "approval_status = 'approved'"];

  if (input.category) {
    params.push(input.category);
    conditions.push(`category = $${params.length}`);
  }

  let orderBy: string;
  if (input.query && input.query.trim()) {
    params.push(input.query.trim());
    const qIdx = params.length;
    orderBy = `(similarity(content, $${qIdx}) * 0.6 + importance * 0.2 + confidence * 0.1 + (CASE WHEN pinned THEN 0.1 ELSE 0 END)) DESC`;
    conditions.push(`(similarity(content, $${qIdx}) > 0.05 OR pinned)`);
  } else {
    orderBy = "pinned DESC, importance DESC, created_at DESC";
  }

  params.push(topK);
  const { rows } = await pool.query<MemoryRow>(
    `SELECT * FROM memory_items WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function listPendingMemory(pool: pg.Pool): Promise<MemoryRow[]> {
  const { rows } = await pool.query<MemoryRow>(
    "SELECT * FROM memory_items WHERE approval_status = 'pending' AND deleted_at IS NULL ORDER BY created_at DESC",
  );
  return rows;
}

export async function updateMemory(
  pool: pg.Pool,
  id: string,
  patch: { content?: string; tags?: string[]; pinned?: boolean; importance?: number },
): Promise<MemoryRow | undefined> {
  const { rows } = await pool.query<MemoryRow>(
    `UPDATE memory_items SET
       content = COALESCE($2, content),
       tags = COALESCE($3, tags),
       pinned = COALESCE($4, pinned),
       importance = COALESCE($5, importance),
       updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, patch.content ?? null, patch.tags ?? null, patch.pinned ?? null, patch.importance ?? null],
  );
  return rows[0];
}

export async function setApprovalStatus(pool: pg.Pool, id: string, status: MemoryApprovalStatus): Promise<MemoryRow | undefined> {
  const { rows } = await pool.query<MemoryRow>(
    "UPDATE memory_items SET approval_status = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *",
    [id, status],
  );
  return rows[0];
}

export async function softDeleteMemory(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("UPDATE memory_items SET deleted_at = now(), updated_at = now() WHERE id = $1", [id]);
}
