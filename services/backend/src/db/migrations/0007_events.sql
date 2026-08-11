-- MD AI — 0007: event bus persistence
-- Every event on the bus is appended here. This table is the durable
-- timeline that (a) powers the Command Center replay/history and (b) lets
-- new WS subscribers catch up on recent events after reconnecting.

CREATE TABLE events (
    id            BIGSERIAL PRIMARY KEY,
    event_type    TEXT NOT NULL,               -- e.g. 'agent.task.completed', 'bot.alert'
    source_type   TEXT NOT NULL CHECK (source_type IN ('agent', 'bot', 'tool', 'model', 'automation', 'system')),
    source_id     TEXT NOT NULL,               -- agent id / bot id / tool id / model id
    task_id       UUID REFERENCES tasks(id) ON DELETE SET NULL,
    payload       JSONB NOT NULL,
    severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug', 'info', 'warn', 'error')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_type_time_idx ON events(event_type, created_at DESC);
CREATE INDEX events_source_idx ON events(source_type, source_id, created_at DESC);
CREATE INDEX events_task_idx ON events(task_id);

-- Retention: application-level job prunes `debug`/`info` events older than
-- N days (configurable via app_config) to keep the table bounded on a
-- 12GB-RAM box; `warn`/`error` events are retained longer by default.
