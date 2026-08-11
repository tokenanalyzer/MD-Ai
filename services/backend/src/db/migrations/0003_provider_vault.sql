-- MD AI — 0003: AI provider registry + provider configuration metadata
--
-- IMPORTANT: this table intentionally holds NO secret material. Provider
-- API keys live in the Android app's Keystore-backed local vault and are
-- sent to the backend transiently, per request, for in-memory use only
-- (see docs/architecture/07-security-model.md §3). `provider_configs`
-- exists so the app/backend can show connection status, remembered
-- default model, and a display-only last-4 fragment WITHOUT the backend
-- ever being the authoritative holder of the secret.
--
-- A future, explicitly opt-in "server secret vault" for backend-only
-- autonomous workflows (bots/automations that must run while the app is
-- closed) is a SEPARATE mechanism, not this table — see
-- docs/architecture/07-security-model.md §3.4. It does not exist yet.

CREATE TABLE providers (
    id              TEXT PRIMARY KEY,             -- e.g. 'nvidia-nemotron', 'gemini', 'groq', 'sambanova', 'openrouter'
    display_name    TEXT NOT NULL,
    base_url        TEXT,                         -- overridable per-provider endpoint
    docs_url        TEXT,
    enabled_builtin BOOLEAN NOT NULL DEFAULT true, -- ships with the app vs. user-added custom provider
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per provider the owner has configured on ANY of their devices.
-- No key material — just enough metadata to render Vault UI status and to
-- let the Model Router know which providers are worth offering as
-- fallback candidates. Multi-device sync of "I have a key for provider X"
-- happens by the app re-reporting `key_last4`/status on each successful
-- local test, not by the backend holding anything reusable.
CREATE TABLE provider_configs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    label             TEXT NOT NULL DEFAULT 'default', -- allows >1 configured key per provider (e.g. personal + org)
    key_last4         TEXT,                          -- display only, e.g. "…a91f"; reported by the client, never derived from a stored key
    status            TEXT NOT NULL DEFAULT 'unverified'
                        CHECK (status IN ('unverified', 'connected', 'error', 'disabled')),
    last_test_at      TIMESTAMPTZ,
    last_test_error   TEXT,
    is_default        BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider_id, label)
);

CREATE INDEX provider_configs_provider_idx ON provider_configs(provider_id);

-- One default model selection per provider config (user-configurable).
CREATE TABLE provider_default_models (
    provider_config_id UUID PRIMARY KEY REFERENCES provider_configs(id) ON DELETE CASCADE,
    model_id            TEXT NOT NULL          -- FK to model_registry.id, added in 0004 (deferred FK below)
);
