import { create } from "zustand";
import { listRecentEvents, type EventDto } from "../api/client.js";
import { openEventsStream } from "../realtime/eventsSocket.js";

const MAX_BUFFERED_EVENTS = 300;

interface EventsState {
  events: EventDto[];
  /** Ids present when the event arrived over the live socket (not the initial REST snapshot) — the Live Event Stream animates only these in, per EventRow's "isNew" contract. */
  liveIds: Set<number>;
  connection: "idle" | "connected" | "error";
  connect: () => Promise<void>;
  disconnect: () => void;
}

let unsubscribe: (() => void) | undefined;

/**
 * M6: single shared live-event buffer for the whole app — the Command
 * Center's Live Event Stream, Agent Detail's "recent activity," and
 * Tools Center's "recent invocations" all read from this one store
 * (filtered client-side by sourceId/type) rather than each screen
 * opening its own WS connection.
 */
export const useEventsStore = create<EventsState>((set, get) => ({
  events: [],
  liveIds: new Set(),
  connection: "idle",

  connect: async () => {
    if (unsubscribe) return; // already connected
    try {
      const snapshot = await listRecentEvents(undefined, 200);
      set({ events: snapshot, connection: "connected" });
      const lastId = snapshot.at(-1)?.id;

      unsubscribe = await openEventsStream(
        {
          onEvent: (event) => {
            set((s) => {
              if (s.events.some((e) => e.id === event.id)) return s; // backlog replay overlap
              const events = [...s.events, event].slice(-MAX_BUFFERED_EVENTS);
              const liveIds = new Set(s.liveIds);
              liveIds.add(event.id);
              return { events, liveIds, connection: "connected" };
            });
          },
          onError: () => set({ connection: "error" }),
          onClose: () => {
            unsubscribe = undefined;
            set({ connection: "error" });
          },
        },
        lastId,
      );
    } catch {
      set({ connection: "error" });
    }
  },

  disconnect: () => {
    unsubscribe?.();
    unsubscribe = undefined;
    set({ connection: "idle" });
  },
}));
