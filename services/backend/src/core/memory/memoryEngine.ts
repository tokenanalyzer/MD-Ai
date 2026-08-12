import type pg from "pg";
import type { MemoryEngine, MemoryItem } from "@mdai/shared-types";
import {
  getMemory,
  insertMemory,
  searchMemory,
  setApprovalStatus,
  softDeleteMemory,
  updateMemory,
  type MemoryRow,
} from "../../db/repositories/memoryRepo.js";

function toMemoryItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    summary: row.summary ?? undefined,
    source: row.source,
    sourceTaskId: row.source_task_id ?? undefined,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    tags: row.tags,
    pinned: row.pinned,
    approvalStatus: row.approval_status,
    supersededBy: row.superseded_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * `core/memory` implementation (docs/architecture — M3.6). Real
 * lexical/trigram-ranked retrieval today; vector search stays a documented
 * near-term addition rather than a faked one — see the schema doc's note
 * on why cross-vendor embedding generation wasn't attempted this
 * milestone.
 */
export class MemoryEngineService implements MemoryEngine {
  constructor(private readonly pool: pg.Pool) {}

  async search(request: { query: string; category?: MemoryItem["category"]; topK?: number }): Promise<MemoryItem[]> {
    const rows = await searchMemory(this.pool, request);
    return rows.map(toMemoryItem);
  }

  async write(request: Parameters<MemoryEngine["write"]>[0]): Promise<MemoryItem> {
    const row = await insertMemory(this.pool, request);
    return toMemoryItem(row);
  }

  async update(id: string, patch: Parameters<MemoryEngine["update"]>[1]): Promise<MemoryItem> {
    const row = await updateMemory(this.pool, id, patch);
    if (!row) throw new Error(`Memory item ${id} not found`);
    return toMemoryItem(row);
  }

  async forget(id: string): Promise<void> {
    await softDeleteMemory(this.pool, id);
  }

  async approve(id: string): Promise<MemoryItem> {
    const row = await setApprovalStatus(this.pool, id, "approved");
    if (!row) throw new Error(`Memory item ${id} not found`);
    return toMemoryItem(row);
  }

  async reject(id: string): Promise<MemoryItem> {
    const row = await setApprovalStatus(this.pool, id, "rejected");
    if (!row) throw new Error(`Memory item ${id} not found`);
    return toMemoryItem(row);
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    const row = await getMemory(this.pool, id);
    return row ? toMemoryItem(row) : undefined;
  }
}
