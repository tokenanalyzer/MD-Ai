import { EventEmitter } from "node:events";
import type pg from "pg";
import type { EventPayload, EventSeverity, EventSourceType } from "@mdai/shared-types";
import { insertEvent, type EventRow } from "../../db/repositories/eventRepo.js";

export interface PublishInput {
  sourceType: EventSourceType;
  sourceId: string;
  taskId?: string;
  severity?: EventSeverity;
  payload: EventPayload;
}

/**
 * Single-process event bus (docs/architecture/05-event-schemas.md).
 * Persists synchronously before fan-out so a WS disconnect can never lose
 * an event, only delay delivery — the WS gateway resumes from `since`
 * against the `events` table.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly pool: pg.Pool) {
    this.emitter.setMaxListeners(50);
  }

  async publish(input: PublishInput): Promise<EventRow> {
    const row = await insertEvent(this.pool, {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      taskId: input.taskId,
      severity: input.severity ?? "info",
      payload: input.payload,
    });
    this.emitter.emit("event", row);
    return row;
  }

  subscribe(listener: (row: EventRow) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
