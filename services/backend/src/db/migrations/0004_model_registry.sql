-- MD AI — 0004: model registry (catalog + live health/capability data)

CREATE TABLE model_registry (
    id                  TEXT PRIMARY KEY,          -- e.g. 'nvidia-nemotron/nemotron-70b-instruct'
    provider_id         TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    provider_model_ref  TEXT NOT NULL,              -- the id the provider API expects
    display_name        TEXT NOT NULL,
    context_length      INT,
    supports_tools      BOOLEAN NOT NULL DEFAULT false,
    supports_vision     BOOLEAN NOT NULL DEFAULT false,
    supports_reasoning  BOOLEAN NOT NULL DEFAULT false,
    supports_streaming  BOOLEAN NOT NULL DEFAULT true,
    modality            TEXT NOT NULL DEFAULT 'text' CHECK (modality IN ('text', 'multimodal')),
    capability_tags     TEXT[] NOT NULL DEFAULT '{}', -- free-form: 'fast', 'cheap', 'long-context', ...

    -- live health, refreshed by the Evolution Engine / router probes
    availability        TEXT NOT NULL DEFAULT 'unknown'
                            CHECK (availability IN ('available', 'degraded', 'unavailable', 'unknown')),
    avg_latency_ms       INT,
    error_rate_pct       NUMERIC(5,2),
    last_verified_at     TIMESTAMPTZ,

    -- user configuration
    user_enabled         BOOLEAN NOT NULL DEFAULT true,
    user_priority         INT NOT NULL DEFAULT 0,     -- higher = preferred among equally-capable models

    discovered_by         TEXT NOT NULL DEFAULT 'manual'
                            CHECK (discovered_by IN ('manual', 'evolution_engine')),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (provider_id, provider_model_ref)
);

CREATE INDEX model_registry_provider_idx ON model_registry(provider_id);
CREATE INDEX model_registry_availability_idx ON model_registry(availability) WHERE user_enabled;

ALTER TABLE provider_default_models
    ADD CONSTRAINT provider_default_models_model_fk
    FOREIGN KEY (model_id) REFERENCES model_registry(id) ON DELETE SET NULL;

-- Rolling per-call performance samples, aggregated periodically into
-- model_registry.avg_latency_ms / error_rate_pct. Kept separate so the
-- registry table itself stays cheap to read on every routing decision.
CREATE TABLE model_call_samples (
    id           BIGSERIAL PRIMARY KEY,
    model_id     TEXT NOT NULL REFERENCES model_registry(id) ON DELETE CASCADE,
    latency_ms   INT NOT NULL,
    success      BOOLEAN NOT NULL,
    error_code   TEXT,
    task_type    TEXT,                              -- what the router requested it for
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX model_call_samples_model_time_idx ON model_call_samples(model_id, created_at DESC);
