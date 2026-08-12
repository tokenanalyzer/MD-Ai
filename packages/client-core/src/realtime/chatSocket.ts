import type { TaskStreamChunk } from "@mdai/shared-types";
import { getClientCoreConfig, wsUrlFrom } from "../platform.js";
import { useSessionStore } from "../state/sessionStore.js";

export interface TaskStreamHandlers {
  onDelta: (text: string) => void;
  onStatus: (state: NonNullable<TaskStreamChunk["state"]>) => void;
  /** M3.9: safe, human-readable delegation status only (e.g. "Research Agent working…") — never chain-of-thought or raw model reasoning. */
  onProgress?: (label: string) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

/**
 * Opens the per-task WS stream (docs/architecture/03-api-contracts.md §2).
 * Token travels as a query param — see backend's chatGateway.ts for why
 * (RN's WebSocket, like browsers', can't set custom handshake headers).
 */
export async function openTaskStream(taskId: string, handlers: TaskStreamHandlers): Promise<() => void> {
  const httpBase = await getClientCoreConfig().getBackendUrl();
  const token = useSessionStore.getState().accessToken;
  const url = `${wsUrlFrom(httpBase)}/ws/tasks/${taskId}?token=${encodeURIComponent(token ?? "")}`;

  const ws = new WebSocket(url);

  ws.onmessage = (event) => {
    try {
      const chunk = JSON.parse(event.data as string) as TaskStreamChunk;
      if (chunk.kind === "token" && chunk.delta) handlers.onDelta(chunk.delta);
      if (chunk.kind === "status" && chunk.state) handlers.onStatus(chunk.state);
      if (chunk.kind === "agent_progress" && chunk.label) handlers.onProgress?.(chunk.label);
    } catch (err) {
      handlers.onError(err instanceof Error ? err : new Error("Failed to parse stream frame"));
    }
  };
  ws.onerror = () => handlers.onError(new Error("Chat stream connection error"));
  ws.onclose = () => handlers.onClose();

  return () => ws.close();
}
