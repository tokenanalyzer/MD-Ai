-- MD AI — 0002: owner identity, device sessions, app config
-- Single-user system: `owner` has exactly one row, seeded at first boot.

CREATE TABLE owner (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name    TEXT NOT NULL,
    unlock_pin_hash TEXT,                       -- argon2id hash, optional local gate
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce single-row table.
CREATE UNIQUE INDEX owner_singleton_idx ON owner ((true));

CREATE TABLE device_sessions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id          UUID NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
    device_name       TEXT NOT NULL,             -- e.g. "Pixel 8", "PC client"
    platform          TEXT NOT NULL CHECK (platform IN ('android', 'pc', 'other')),
    refresh_token_hash TEXT NOT NULL,             -- SHA-256 of refresh token, never plaintext
    push_token        TEXT,                       -- FCM token for notifications
    last_seen_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at        TIMESTAMPTZ
);

CREATE INDEX device_sessions_owner_idx ON device_sessions(owner_id) WHERE revoked_at IS NULL;

-- Small typed key/value store for system-wide settings that don't warrant
-- their own table (default model preference, theme flags, feature toggles).
CREATE TABLE app_config (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
