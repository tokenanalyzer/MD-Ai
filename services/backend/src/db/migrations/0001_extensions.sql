-- MD AI — 0001: baseline extensions
-- Requires PostgreSQL 16+ with pgvector available (arm64 build).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;     -- memory embeddings
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy text search over memory/events
