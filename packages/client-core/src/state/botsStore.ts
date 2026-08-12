import { create } from "zustand";
import {
  listBotFindings,
  listBotRuns,
  listBots,
  patchBot,
  runBotNow,
  type BotDto,
  type BotFindingDto,
  type BotRunDto,
} from "../api/client.js";

interface BotDetail {
  runs: BotRunDto[];
  findings: BotFindingDto[];
  loadingDetail: boolean;
  runningNow: boolean;
}

interface BotsState {
  bots: BotDto[];
  loading: boolean;
  error: string | null;
  detail: Record<string, BotDetail>;
  loadBots: () => Promise<void>;
  loadDetail: (botId: string) => Promise<void>;
  setEnabled: (botId: string, enabled: boolean) => Promise<void>;
  setPaused: (botId: string, paused: boolean) => Promise<void>;
  runNow: (botId: string) => Promise<void>;
}

/** M5.16: Bot Fleet screen state — a thin REST-polling store, not WS-driven (bots run on a schedule measured in minutes, not a live stream). */
export const useBotsStore = create<BotsState>((set, get) => ({
  bots: [],
  loading: false,
  error: null,
  detail: {},

  loadBots: async () => {
    set({ loading: true, error: null });
    try {
      const bots = await listBots();
      set({ bots, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load bots" });
    }
  },

  loadDetail: async (botId) => {
    set((s) => ({ detail: { ...s.detail, [botId]: { ...emptyDetail(s.detail[botId]), loadingDetail: true } } }));
    try {
      const [runs, findings] = await Promise.all([listBotRuns(botId), listBotFindings(botId)]);
      set((s) => ({ detail: { ...s.detail, [botId]: { ...emptyDetail(s.detail[botId]), runs, findings, loadingDetail: false } } }));
    } catch {
      set((s) => ({ detail: { ...s.detail, [botId]: { ...emptyDetail(s.detail[botId]), loadingDetail: false } } }));
    }
  },

  setEnabled: async (botId, enabled) => {
    const updated = await patchBot(botId, { enabled });
    set((s) => ({ bots: s.bots.map((b) => (b.id === botId ? updated : b)) }));
  },

  setPaused: async (botId, paused) => {
    const updated = await patchBot(botId, { paused });
    set((s) => ({ bots: s.bots.map((b) => (b.id === botId ? updated : b)) }));
  },

  runNow: async (botId) => {
    set((s) => ({ detail: { ...s.detail, [botId]: { ...emptyDetail(s.detail[botId]), runningNow: true } } }));
    try {
      await runBotNow(botId);
    } finally {
      set((s) => ({ detail: { ...s.detail, [botId]: { ...emptyDetail(s.detail[botId]), runningNow: false } } }));
      await get().loadBots();
      await get().loadDetail(botId);
    }
  },
}));

function emptyDetail(existing?: BotDetail): BotDetail {
  return existing ?? { runs: [], findings: [], loadingDetail: false, runningNow: false };
}
