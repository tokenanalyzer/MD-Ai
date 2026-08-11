-- MD AI — 0016: M2 — structured output capability + richer call telemetry

ALTER TABLE model_registry
    ADD COLUMN supports_structured_output BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE model_call_samples
    ADD COLUMN provider_id TEXT REFERENCES providers(id) ON DELETE CASCADE,
    ADD COLUMN task_category TEXT,
    ADD COLUMN timed_out BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN used_as_fallback BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN input_tokens INT,
    ADD COLUMN output_tokens INT,
    ADD COLUMN response_status TEXT;

-- Backfill provider_id for any samples inserted before this column existed
-- (none expected outside dev/test databases, but keeps the column honest).
UPDATE model_call_samples s
SET provider_id = mr.provider_id
FROM model_registry mr
WHERE s.model_id = mr.id AND s.provider_id IS NULL;

CREATE INDEX model_call_samples_provider_time_idx ON model_call_samples(provider_id, created_at DESC);
