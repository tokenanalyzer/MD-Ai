-- MD AI — 0006: A2A task lifecycle (delegation, messages, results)

CREATE TABLE conversations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at  TIMESTAMPTZ
);

CREATE TABLE tasks (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
    parent_task_id     UUID REFERENCES tasks(id) ON DELETE CASCADE, -- delegated sub-tasks
    created_by_agent   TEXT REFERENCES agents(id),                   -- NULL when created directly by the user
    assigned_agent_id  TEXT NOT NULL REFERENCES agents(id),
    task_type          TEXT NOT NULL,                                 -- router/classification label
    state               TEXT NOT NULL DEFAULT 'submitted'
                            CHECK (state IN (
                                'submitted', 'working', 'input-required',
                                'completed', 'failed', 'canceled'
                            )),
    input               JSONB NOT NULL,
    output               JSONB,
    error                JSONB,
    model_id             TEXT REFERENCES model_registry(id),
    started_at           TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tasks_conversation_idx ON tasks(conversation_id);
CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);
CREATE INDEX tasks_assigned_agent_state_idx ON tasks(assigned_agent_id, state);

-- A2A "Message" with ordered "Part"s (text/file/data), attributable to a
-- task, an agent, or the user.
CREATE TABLE task_messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK (role IN ('user', 'agent', 'tool', 'system')),
    from_agent_id TEXT REFERENCES agents(id),
    parts         JSONB NOT NULL,               -- Part[] — see shared-types/a2a
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX task_messages_task_idx ON task_messages(task_id, created_at);
