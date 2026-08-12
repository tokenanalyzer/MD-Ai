import { create } from "zustand";
import { getHealth, type HealthReportDto } from "../api/client";

interface SystemStatusState {
  report: HealthReportDto | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  refresh: () => Promise<void>;
}

/** M6 System Status panel — real `/health` telemetry (Postgres/Redis/queues/CPU/memory), polled on an interval by the Command Center screen rather than pushed over the event stream (health isn't event-driven data). */
export const useSystemStatusStore = create<SystemStatusState>((set) => ({
  report: null,
  loading: false,
  error: null,
  lastFetchedAt: null,

  refresh: async () => {
    set((s) => ({ loading: s.report === null, error: null }));
    try {
      const report = await getHealth();
      set({ report, loading: false, lastFetchedAt: Date.now() });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load system status" });
    }
  },
}));
