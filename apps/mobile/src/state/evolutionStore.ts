import { create } from "zustand";
import {
  approveEvolutionProposal,
  decideToolApproval,
  listEvolutionProposals,
  listToolApprovals,
  rejectEvolutionProposal,
  triggerEvolutionSweep,
  type EvolutionProposalDto,
  type ToolApprovalDto,
} from "../api/client";

interface EvolutionState {
  proposals: EvolutionProposalDto[];
  toolApprovals: ToolApprovalDto[];
  loading: boolean;
  error: string | null;
  decidingId: string | null;
  sweeping: boolean;
  load: () => Promise<void>;
  approveProposal: (id: string) => Promise<void>;
  rejectProposal: (id: string) => Promise<void>;
  decideTool: (invocationId: string, decision: "approved" | "denied") => Promise<void>;
  runSweepNow: () => Promise<void>;
}

/**
 * M9 Approvals screen state — everything a human hasn't yet decided:
 * evolution proposals that require approval (`GET /evolution/proposals`,
 * filtered client-side to `status in {proposed, sandbox_tested}` since
 * only those are actionable) and tool invocations Guardian left
 * `awaiting_approval` (M8). Both queues come from real backend state;
 * this store never fabricates a pending item.
 */
export const useEvolutionStore = create<EvolutionState>((set, get) => ({
  proposals: [],
  toolApprovals: [],
  loading: false,
  error: null,
  decidingId: null,
  sweeping: false,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [proposals, toolApprovals] = await Promise.all([listEvolutionProposals(), listToolApprovals()]);
      set({ proposals, toolApprovals, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load approvals" });
    }
  },

  approveProposal: async (id) => {
    set({ decidingId: id });
    try {
      await approveEvolutionProposal(id);
    } finally {
      set({ decidingId: null });
      await get().load();
    }
  },

  rejectProposal: async (id) => {
    set({ decidingId: id });
    try {
      await rejectEvolutionProposal(id);
    } finally {
      set({ decidingId: null });
      await get().load();
    }
  },

  decideTool: async (invocationId, decision) => {
    set({ decidingId: invocationId });
    try {
      await decideToolApproval(invocationId, decision);
    } finally {
      set({ decidingId: null });
      await get().load();
    }
  },

  runSweepNow: async () => {
    set({ sweeping: true });
    try {
      await triggerEvolutionSweep();
    } finally {
      set({ sweeping: false });
      await get().load();
    }
  },
}));
