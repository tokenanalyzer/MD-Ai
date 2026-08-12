import { create } from "zustand";
import { getAgentDelegations, listAgents, setAgentEnabled, type AgentCardDto } from "../api/client";

interface AgentsState {
  agents: AgentCardDto[];
  loading: boolean;
  error: string | null;
  delegations: Record<string, AgentCardDto[]>;
  loadAgents: () => Promise<void>;
  loadDelegations: (agentId: string) => Promise<void>;
  setEnabled: (agentId: string, enabled: boolean) => Promise<void>;
}

/** M6: shared Agent Registry snapshot — Command Center's AgentNetwork, the Agent Center list, and Agent Detail all read from this one store rather than each issuing its own GET /agents. */
export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  loading: false,
  error: null,
  delegations: {},

  loadAgents: async () => {
    set({ loading: true, error: null });
    try {
      const agents = await listAgents();
      set({ agents, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load agents" });
    }
  },

  loadDelegations: async (agentId) => {
    try {
      const options = await getAgentDelegations(agentId);
      set((s) => ({ delegations: { ...s.delegations, [agentId]: options } }));
    } catch {
      // Non-fatal — Agent Detail just shows an empty delegation list rather than blocking the whole screen.
    }
  },

  setEnabled: async (agentId, enabled) => {
    const updated = await setAgentEnabled(agentId, enabled);
    set((s) => ({ agents: s.agents.map((a) => (a.id === agentId ? updated : a)) }));
  },
}));
