import { EventEmitter } from "node:events";
import type { TaskStreamChunk } from "@mdai/shared-types";

interface HubEntry {
  emitter: EventEmitter;
  buffer: TaskStreamChunk[];
  finished: boolean;
}

const MAX_BUFFERED_CHUNKS = 500;
const LINGER_AFTER_FINISH_MS = 30_000;

const hubs = new Map<string, HubEntry>();

function getOrCreate(taskId: string): HubEntry {
  let entry = hubs.get(taskId);
  if (!entry) {
    entry = { emitter: new EventEmitter(), buffer: [], finished: false };
    entry.emitter.setMaxListeners(10);
    hubs.set(taskId, entry);
  }
  return entry;
}

/**
 * Per-task in-process pub/sub bridging the async-generator chat pipeline
 * (core/agents/masterAgent.ts) to WebSocket clients on `/ws/tasks/:id`
 * (docs/architecture/03-api-contracts.md §2). A REST POST creates the task
 * and starts the generator immediately; the WS connection can attach a
 * moment later and still catch the buffered chunks-so-far, so the two
 * steps don't have to land in the same millisecond.
 */
export function publishChunk(taskId: string, chunk: TaskStreamChunk): void {
  const entry = getOrCreate(taskId);
  entry.buffer.push(chunk);
  if (entry.buffer.length > MAX_BUFFERED_CHUNKS) entry.buffer.shift();
  entry.emitter.emit("chunk", chunk);
}

export function finishTask(taskId: string): void {
  const entry = getOrCreate(taskId);
  entry.finished = true;
  entry.emitter.emit("finished");
  setTimeout(() => hubs.delete(taskId), LINGER_AFTER_FINISH_MS);
}

export function subscribeToTask(
  taskId: string,
  onChunk: (chunk: TaskStreamChunk) => void,
  onFinished: () => void,
): { replay: TaskStreamChunk[]; alreadyFinished: boolean; unsubscribe: () => void } {
  const entry = getOrCreate(taskId);
  entry.emitter.on("chunk", onChunk);
  entry.emitter.on("finished", onFinished);
  return {
    replay: [...entry.buffer],
    alreadyFinished: entry.finished,
    unsubscribe: () => {
      entry.emitter.off("chunk", onChunk);
      entry.emitter.off("finished", onFinished);
    },
  };
}

export function resetChatStreamHubForTests(): void {
  hubs.clear();
}
