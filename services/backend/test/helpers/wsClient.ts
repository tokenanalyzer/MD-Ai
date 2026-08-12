import WebSocket from "ws";
import type { TaskStreamChunk } from "@mdai/shared-types";

/** M6: for a persistent (never-self-closing) WS stream like `/ws/events` — resolves once `count` messages arrive, then closes the socket client-side. Unlike `collectTaskStream`, which waits for the server to close a per-task stream. */
export function collectWsFrames<T>(url: string, count: number, timeoutMs = 5000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const frames: T[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WS did not receive ${count} frame(s) within ${timeoutMs}ms; got: ${JSON.stringify(frames)}`));
    }, timeoutMs);

    ws.on("message", (data) => {
      frames.push(JSON.parse(data.toString()));
      if (frames.length >= count) {
        clearTimeout(timer);
        ws.close();
        resolve(frames);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Connects to a task's WS stream and resolves once the server closes the connection, collecting every frame in order. */
export function collectTaskStream(url: string, timeoutMs = 5000): Promise<TaskStreamChunk[]> {
  return new Promise((resolve, reject) => {
    const frames: TaskStreamChunk[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WS stream did not close within ${timeoutMs}ms; frames so far: ${JSON.stringify(frames)}`));
    }, timeoutMs);

    ws.on("message", (data) => {
      frames.push(JSON.parse(data.toString()));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      resolve(frames);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
