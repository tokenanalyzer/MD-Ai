import type { EventDto } from "../api/client.js";
import { getClientCoreConfig, wsUrlFrom } from "../platform.js";
import { useSessionStore } from "../state/sessionStore.js";

export interface EventsStreamHandlers {
  onEvent: (event: EventDto) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

/**
 * M6: connects to the general `/ws/events` gateway (services/backend/src/
 * api/ws/eventsGateway.ts) for the Command Center's Live Event Stream —
 * same auth-via-query-param pattern as chatSocket.ts's per-task stream,
 * but persistent (never server-closed) and resumable via `sinceId` so a
 * reconnect after the phone was backgrounded replays exactly what was
 * missed, never a gap and never a duplicate.
 */
export async function openEventsStream(handlers: EventsStreamHandlers, sinceId?: number): Promise<() => void> {
  const httpBase = await getClientCoreConfig().getBackendUrl();
  const token = useSessionStore.getState().accessToken;
  const params = new URLSearchParams();
  params.set("token", token ?? "");
  if (sinceId !== undefined) params.set("since", String(sinceId));

  const ws = new WebSocket(`${wsUrlFrom(httpBase)}/ws/events?${params.toString()}`);

  ws.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data as string) as EventDto;
      handlers.onEvent(parsed);
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err : new Error("Failed to parse event frame"));
    }
  };
  ws.onerror = () => handlers.onError?.(new Error("Events stream connection error"));
  ws.onclose = () => handlers.onClose?.();

  return () => ws.close();
}
