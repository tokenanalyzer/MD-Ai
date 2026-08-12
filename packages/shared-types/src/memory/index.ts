export type MemoryCategory =
  | "personal_context"
  | "projects"
  | "goals"
  | "preferences"
  | "decisions"
  | "research"
  | "knowledge"
  | "conversations"
  | "agent_lessons";

export type MemoryApprovalStatus = "approved" | "pending" | "rejected";

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  content: string;
  summary?: string;
  source: string;
  sourceTaskId?: string;
  confidence: number;
  /** 0-1, how much this should weigh in retrieval ranking versus recency/relevance alone. */
  importance: number;
  tags: string[];
  pinned: boolean;
  /**
   * "approved": stored and retrievable (the default for explicit "Remember
   * this." commands — direct user intent is its own approval).
   * "pending": system-proposed candidate, not yet retrievable until
   * approved — see docs/architecture/07-security-model.md for why
   * sensitive/personal candidates default here instead of auto-storing.
   */
  approvalStatus: MemoryApprovalStatus;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryWriteRequest {
  category: MemoryCategory;
  content: string;
  tags?: string[];
  pinned?: boolean;
  importance?: number;
  confidence?: number;
  source: string;
  sourceTaskId?: string;
  approvalStatus?: MemoryApprovalStatus;
}

export interface MemorySearchRequest {
  query: string;
  category?: MemoryCategory;
  topK?: number;
}

/**
 * Implemented in `core/memory`. In M3 the Master Agent is the only caller
 * (there is no dedicated memory-agent yet — see
 * docs/architecture/04-agent-interfaces.md), which keeps write access to a
 * single, auditable path without adding a fourth agent this milestone.
 */
export interface MemoryEngine {
  search(request: MemorySearchRequest): Promise<MemoryItem[]>;
  write(request: MemoryWriteRequest): Promise<MemoryItem>;
  update(id: string, patch: Partial<Pick<MemoryItem, "content" | "tags" | "pinned" | "importance">>): Promise<MemoryItem>;
  forget(id: string): Promise<void>;
  approve(id: string): Promise<MemoryItem>;
  reject(id: string): Promise<MemoryItem>;
}
