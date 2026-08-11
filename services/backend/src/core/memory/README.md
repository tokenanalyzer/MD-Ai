# core/memory

Implements `MemoryEngine` (`@mdai/shared-types`): structured storage over
`memory_items`, embedding generation + `pgvector` HNSW semantic search,
relevance scoring, soft delete. Only `memory-agent` calls this directly.
See `docs/architecture/02-database-schema.md` §3 and
`docs/architecture/04-agent-interfaces.md`.
