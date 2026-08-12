import { create } from "zustand";
import {
  approveMemory,
  createMemory,
  forgetMemory,
  listApprovedMemory,
  listPendingMemory,
  listRejectedMemory,
  rejectMemory,
  type MemoryCategory,
  type MemoryItemDto,
} from "../api/client";

interface MemoryState {
  approved: MemoryItemDto[];
  pending: MemoryItemDto[];
  rejected: MemoryItemDto[];
  loading: boolean;
  error: string | null;
  loadAll: () => Promise<void>;
  /** M6.7 explicit "Remember" — always creates an already-approved, user-sourced memory. Never invoked automatically. */
  remember: (input: { category: MemoryCategory; content: string; tags?: string[]; pinned?: boolean }) => Promise<void>;
  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  /** M6.7 explicit "Forget" — the only way an approved memory is removed. */
  forget: (id: string) => Promise<void>;
}

/** M6.7 Memory Center — approved/pending/rejected straight from the existing memory subsystem (M3.6/M3.7). No automatic memory behavior is invented here: pending items arrive only from Master's own classifier proposing a memoryCandidate, and this screen only ever acts on explicit user taps (Remember/Approve/Reject/Forget). */
export const useMemoryStore = create<MemoryState>((set) => ({
  approved: [],
  pending: [],
  rejected: [],
  loading: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [approved, pending, rejected] = await Promise.all([listApprovedMemory(), listPendingMemory(), listRejectedMemory()]);
      set({ approved, pending, rejected, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load memory" });
    }
  },

  remember: async (input) => {
    const item = await createMemory(input);
    set((s) => ({ approved: [item, ...s.approved] }));
  },

  approve: async (id) => {
    const item = await approveMemory(id);
    set((s) => ({ pending: s.pending.filter((m) => m.id !== id), approved: [item, ...s.approved] }));
  },

  reject: async (id) => {
    const item = await rejectMemory(id);
    set((s) => ({ pending: s.pending.filter((m) => m.id !== id), rejected: [item, ...s.rejected] }));
  },

  forget: async (id) => {
    await forgetMemory(id);
    set((s) => ({
      approved: s.approved.filter((m) => m.id !== id),
      pending: s.pending.filter((m) => m.id !== id),
      rejected: s.rejected.filter((m) => m.id !== id),
    }));
  },
}));
