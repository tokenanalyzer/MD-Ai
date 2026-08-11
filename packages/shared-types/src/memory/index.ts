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

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  content: string;
  summary?: string;
  source: string;
  sourceTaskId?: string;
  confidence: number;
  tags: string[];
  pinned: boolean;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryWriteRequest {
  category: MemoryCategory;
  content: string;
  tags?: string[];
  pinned?: boolean;
  source: string;
  sourceTaskId?: string;
}

export interface MemorySearchRequest {
  query: string;
  category?: MemoryCategory;
  topK?: number;
}

/**
 * Implemented in core/memory. The `memory-agent` (see shared-types/agents)
 * is the only agent that calls this directly; other agents request memory
 * operations by delegating to memory-agent, keeping write access to a
 * single, auditable path.
 */
export interface MemoryEngine {
  search(request: MemorySearchRequest): Promise<MemoryItem[]>;
  write(request: MemoryWriteRequest): Promise<MemoryItem>;
  update(id: string, patch: Partial<Pick<MemoryItem, "content" | "tags" | "pinned">>): Promise<MemoryItem>;
  forget(id: string): Promise<void>;
}
