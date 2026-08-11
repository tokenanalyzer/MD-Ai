import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import type pg from "pg";
import type { TaskStreamChunk } from "@mdai/shared-types";
import { InvalidTokenError, verifyAccessToken } from "../../core/security/jwt.js";
import { findActiveSessionById } from "../../db/repositories/deviceSessionRepo.js";
import { subscribeToTask } from "./chatStreamHub.js";

const TASK_WS_PATH = /^\/ws\/tasks\/([^/]+)$/;

function handleTaskConnection(ws: WebSocket, taskId: string): void {
  const send = (chunk: TaskStreamChunk): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(chunk));
  };

  const { replay, alreadyFinished, unsubscribe } = subscribeToTask(taskId, send, () => {
    ws.close(1000, "task finished");
  });

  for (const chunk of replay) send(chunk);
  if (alreadyFinished) ws.close(1000, "task finished");

  ws.on("close", unsubscribe);
}

/**
 * WS gateway for `/ws/tasks/:id` (docs/architecture/03-api-contracts.md
 * §2). Auth via `?token=<accessToken>` query param — browser/React Native
 * WebSocket clients can't set arbitrary headers on the handshake, so the
 * access token travels the same way it would on any other query-string
 * auth pattern; it is short-lived (15 min, docs/architecture/
 * 07-security-model.md §2) which bounds exposure in server access logs.
 */
export function attachChatGateway(server: Server, pool: pg.Pool): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://internal");
    const match = TASK_WS_PATH.exec(url.pathname);
    if (!match) return; // not our path — leave the socket alone

    const taskId = match[1] as string;
    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    void (async () => {
      try {
        const claims = verifyAccessToken(token);
        const session = await findActiveSessionById(pool, claims.sub);
        if (!session) throw new InvalidTokenError("Session revoked or not found");
        wss.handleUpgrade(req, socket, head, (ws) => handleTaskConnection(ws, taskId));
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      }
    })();
  });

  return wss;
}
