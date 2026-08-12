import { create } from "zustand";
import {
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  patchAutomation,
  runAutomationNow,
  type AutomationActionType,
  type AutomationDto,
  type AutomationRunDto,
  type AutomationTriggerType,
} from "../api/client.js";

interface AutomationsState {
  automations: AutomationDto[];
  loading: boolean;
  error: string | null;
  runs: Record<string, AutomationRunDto[]>;
  runningNow: string | null;
  lastCreatedWebhookSecret: string | null;
  loadAutomations: () => Promise<void>;
  loadRuns: (automationId: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  create: (input: {
    name: string;
    description?: string;
    triggerType: AutomationTriggerType;
    triggerConfig?: Record<string, unknown>;
    actionType: AutomationActionType;
    actionConfig?: Record<string, unknown>;
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<void>;
}

/**
 * M10 Automations screen state — first written directly against
 * `@mdai/client-core` rather than a mobile-only store, so a future PC
 * client gets this for free with zero duplicated business logic. Mirrors
 * `botsStore.ts`'s shape: a thin REST-polling store, not WS-driven.
 */
export const useAutomationsStore = create<AutomationsState>((set, get) => ({
  automations: [],
  loading: false,
  error: null,
  runs: {},
  runningNow: null,
  lastCreatedWebhookSecret: null,

  loadAutomations: async () => {
    set({ loading: true, error: null });
    try {
      const automations = await listAutomations();
      set({ automations, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load automations" });
    }
  },

  loadRuns: async (automationId) => {
    try {
      const runs = await listAutomationRuns(automationId);
      set((s) => ({ runs: { ...s.runs, [automationId]: runs } }));
    } catch {
      // Non-fatal — the detail view just shows an empty run history.
    }
  },

  setEnabled: async (id, enabled) => {
    const updated = await patchAutomation(id, { enabled });
    set((s) => ({ automations: s.automations.map((a) => (a.id === id ? updated : a)) }));
  },

  create: async (input) => {
    const created = await createAutomation(input);
    set((s) => ({ automations: [created, ...s.automations], lastCreatedWebhookSecret: created.webhookSecret ?? null }));
  },

  remove: async (id) => {
    await deleteAutomation(id);
    set((s) => ({ automations: s.automations.filter((a) => a.id !== id) }));
  },

  runNow: async (id) => {
    set({ runningNow: id });
    try {
      await runAutomationNow(id);
    } finally {
      set({ runningNow: null });
      await get().loadRuns(id);
    }
  },
}));
