-- MD AI — 0003: AI provider registry + encrypted API key vault
-- Provider keys are envelope-encrypted (see docs/architecture/07-security-model.md).
-- The `ciphertext`/`nonce`/`auth_tag` columns hold AES-256-GCM output; the raw
-- key is NEVER stored and NEVER logged.

CREATE TABLE providers (
    id              TEXT PRIMARY KEY,             -- e.g. 'nvidia-nemotron', 'gemini', 'groq', 'sambanova', 'openrouter'
    display_name    TEXT NOT NULL,
    base_url        TEXT,                         -- overridable per-provider endpoint
    docs_url        TEXT,
    enabled_builtin BOOLEAN NOT NULL DEFAULT true, -- ships with the app vs. user-added custom provider
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE provider_credentials (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    label             TEXT NOT NULL DEFAULT 'default', -- allows >1 key per provider
    key_ciphertext    BYTEA NOT NULL,
    key_nonce         BYTEA NOT NULL,
    key_auth_tag      BYTEA NOT NULL,
    key_last4         TEXT NOT NULL,                -- display only, e.g. "…a91f"
    dek_wrapped       BYTEA NOT NULL,                -- data-encryption-key wrapped by the KEK
    kek_version       INT NOT NULL DEFAULT 1,        -- supports KEK rotation
    status            TEXT NOT NULL DEFAULT 'unverified'
                        CHECK (status IN ('unverified', 'connected', 'error', 'disabled')),
    last_test_at      TIMESTAMPTZ,
    last_test_error   TEXT,
    is_default        BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider_id, label)
);

CREATE INDEX provider_credentials_provider_idx ON provider_credentials(provider_id);

-- One default model selection per provider credential (user-configurable).
CREATE TABLE provider_default_models (
    provider_credential_id UUID PRIMARY KEY REFERENCES provider_credentials(id) ON DELETE CASCADE,
    model_id                TEXT NOT NULL          -- FK to model_registry.id, added in 0004 (deferred FK below)
);
