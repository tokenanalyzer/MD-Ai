# core/security

Device pairing + session JWT issuance/verification, `provider_configs`
metadata read/write (status only — no key material ever passes through
here at rest, only transiently within a request handler), log redaction
config, Guardian Agent policy checks, audit log writer. See
`docs/architecture/07-security-model.md`.
