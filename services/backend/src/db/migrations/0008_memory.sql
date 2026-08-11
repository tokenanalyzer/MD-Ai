-- MD AI — 0008: structured, retrievable long-term memory
-- Embedding dimension (1536) matches the default embedding model configured
-- in app_config['memory.embedding_model']. If that model changes to a
-- different dimension, a new migration must ALTER the column — tracked in
-- docs/architecture/02-database-schema.md "Changing the embedding model".

CREATE TABLE memory_items (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category       TEXT NOT NULL CHECK (category IN (
                        'personal_context', 'projects', 'goals', 'preferences',
                        'decisions', 'research', 'knowledge', 'conversations',
                        'agent_lessons'
                    )),
    content        TEXT NOT NULL,
    summary        TEXT,                          -- short form used in retrieval previews
    source         TEXT NOT NULL,                  -- 'user', 'master', 'research-agent', etc.
    source_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    confidence     NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
    embedding      vector(1536),
    tags           TEXT[] NOT NULL DEFAULT '{}',
    pinned         BOOLEAN NOT NULL DEFAULT false, -- user-marked as always-relevant
    superseded_by  UUID REFERENCES memory_items(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ                      -- soft delete: user control over forgetting
);

CREATE INDEX memory_items_category_idx ON memory_items(category) WHERE deleted_at IS NULL;
CREATE INDEX memory_items_tags_idx ON memory_items USING GIN(tags);
CREATE INDEX memory_items_content_trgm_idx ON memory_items USING GIN(content gin_trgm_ops);

-- Approximate nearest-neighbor index for semantic retrieval.
CREATE INDEX memory_items_embedding_idx ON memory_items
    USING hnsw (embedding vector_cosine_ops)
    WHERE deleted_at IS NULL;
