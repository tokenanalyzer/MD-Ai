import WebSocket from "ws";
import type { TaskStreamChunk } from "@mdai/shared-types";

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
