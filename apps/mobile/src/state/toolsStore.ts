import { create } from "zustand";
import { listTools, type ToolDefinitionDto } from "../api/client";

interface ToolsState {
  tools: ToolDefinitionDto[];
  loading: boolean;
  error: string | null;
  loadTools: () => Promise<void>;
}

/** M6.8 Tools Center — real Tool Registry snapshot (M4.1). No secrets or raw invocation payloads ever pass through this store; ToolDefinitionDto has no key/credential fields. */
export const useToolsStore = create<ToolsState>((set) => ({
  tools: [],
  loading: false,
  error: null,

  loadTools: async () => {
    set({ loading: true, error: null });
    try {
      const tools = await listTools();
      set({ tools, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load tools" });
    }
  },
}));
