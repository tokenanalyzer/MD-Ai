import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import type pg from "pg";
import { InvalidTokenError, verifyAccessToken } from "../../core/security/jwt.js";
import { findActiveSessionById } from "../../db/repositories/deviceSessionRepo.js";
import { listEventsSince, type EventRow } from "../../db/repositories/eventRepo.js";
import type { EventBus } from "../../core/events/eventBus.js";

const EVENTS_WS_PATH = "/ws/events";

function toWireEvent(row: EventRow) {
  return {
    id: row.id,
    type: row.event_type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    taskId: row.task_id ?? undefined,
    severity: row.severity,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

async function handleEventsConnection(
  ws: WebSocket,
  pool: pg.Pool,
  eventBus: EventBus,
  sinceId: number | undefined,
  types: string[] | undefined,
): Promise<void> {
  const send = (row: EventRow): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(toWireEvent(row)));
  };

  // Resume-by-cursor (docs/architecture/05-event-schemas.md §2): replay
  // everything since the client's last-seen id before switching to live
  // push, so a reconnect after the phone was asleep doesn't lose events.
  const backlog = await listEventsSince(pool, { sinceId, types, limit: 200 });
  for (const row of backlog) send(row);

  const unsubscribe = eventBus.subscribe((row) => {
    if (types && !types.includes(row.event_type)) return;
    send(row);
  });

  ws.on("close", unsubscribe);
}

/**
 * M6: the general `/ws/events` gateway the roadmap's M6 entry described
 * ("core/events bus + /ws/events gateway with resume-by-cursor") — the
 * Command Center's Live Event Stream is real, not polled/faked: every
 * frame is the identical `EventEnvelope`-shaped payload the `events`
 * table and the M1-M5 per-task WS gateway already use, just fanned out
 * unfiltered (optionally narrowed via `?types=a,b,c`) instead of scoped
 * to one task. Auth follows chatGateway.ts's exact pattern — a
 * short-lived access token as a query param, since WebSocket clients
 * can't set custom handshake headers.
 */
export function attachEventsGateway(server: Server, pool: pg.Pool, eventBus: EventBus): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://internal");
    if (url.pathname !== EVENTS_WS_PATH) return; // not our path — leave the socket alone

    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sinceParam = url.searchParams.get("since");
    const sinceId = sinceParam !== null ? Number(sinceParam) : undefined;
    const typesParam = url.searchParams.get("types");
    const types = typesParam ? typesParam.split(",") : undefined;

    void (async () => {
      try {
        const claims = verifyAccessToken(token);
        const session = await findActiveSessionById(pool, claims.sub);
        if (!session) throw new InvalidTokenError("Session revoked or not found");
        wss.handleUpgrade(req, socket, head, (ws) =>
          void handleEventsConnection(ws, pool, eventBus, Number.isFinite(sinceId) ? sinceId : undefined, types),
        );
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      }
    })();
  });

  return wss;
}
