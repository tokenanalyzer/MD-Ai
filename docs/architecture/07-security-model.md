# Security Model

## 1. Threat model

MD AI has one legitimate user, but the backend is a networked service
reachable from the internet (so the phone can reach it from anywhere). The
realistic threats are therefore: **unauthorized access to the backend**
(not "other tenants" — there are none), **provider key exfiltration**, and
**runaway/compromised automation or self-modification**. Design responses:

| Threat | Mitigation |
|---|---|
| Backend endpoint discovered/scanned by internet | No public unauthenticated routes except `/auth/pair` (single-use code) and signed automation webhooks; prefer not exposing a public IP at all (see `08-deployment-architecture.md` — Cloudflare Tunnel / WireGuard) |
| Stolen/lost phone | Device sessions are individually revocable (`/auth/revoke`); local app unlock gated by Keystore-backed biometric/PIN before the session token is even usable |
| Provider key theft via DB dump | Keys are envelope-encrypted, never stored plaintext; DB dump alone is insufficient without the KEK (which is not co-located with the DB backup) |
| Provider key theft via logs/crash reports | Structural redaction — see §3 |
| A tool or automation taking an irreversible action | `tools.requires_approval` + `evolution_proposals` approval gate — see §5 |
| Self-modification going rogue | Five change classes, two of which can never auto-apply — see §5 |

## 2. AuthN/AuthZ

- **Single owner identity** (`owner` table), no roles/permissions matrix —
  authorization is simply "does this device session belong to the owner and
  is it unrevoked."
- **Device pairing**: first boot generates a single-use pairing code
  (printed to the backend's own log, not transmitted anywhere) with a short
  TTL. The app exchanges it for an `accessToken`/`refreshToken` pair via
  `POST /auth/pair`. This is the *only* unauthenticated write endpoint.
- **Tokens**: short-lived signed JWT access token (~15 min) + opaque
  refresh token, hash-stored (`device_sessions.refresh_token_hash`), never
  stored reversibly server-side.
- **Local gate**: the mobile app additionally requires biometric/PIN unlock
  before it will present the stored session token to the backend, using
  `expo-secure-store` (Android Keystore-backed). This protects a lost/unlocked
  phone, not the backend itself.
- **Automation webhooks** (`/webhooks/automations/:slug`) use a per-automation
  HMAC-signed slug instead of the device bearer token, since the caller
  (e.g. n8n) isn't the paired device.

## 3. Provider API key vault

**Storage**: envelope encryption, AES-256-GCM.
- A random 256-bit **Data Encryption Key (DEK)** is generated per credential.
- The provider key is encrypted with the DEK → `key_ciphertext` / `key_nonce`
  / `key_auth_tag`.
- The DEK itself is encrypted ("wrapped") with a **Key Encryption Key
  (KEK)** → `dek_wrapped`. The KEK lives outside the database: as an Oracle
  Cloud Vault secret if available, or as a container-runtime secret injected
  via environment at process start (never committed, never baked into the
  Docker image — see `08-deployment-architecture.md`). `kek_version` supports
  rotating the KEK without re-encrypting every DEK in one blocking operation.
- **Decryption happens only at call time**, inside the provider-adapter call
  path, and the decrypted key is held only for the duration of that one
  outbound request — never cached, never written to a log field, never
  included in an event payload.

**Why not rely on Android Keystore for the authoritative copy**: see
`01-repository-structure.md` §3 — bots/agents must keep running while the
phone is off, which requires the backend to hold a usable copy
independently of the device.

**API surface guarantees** (`03-api-contracts.md` §3):
- `GET` credential endpoints return `keyLast4` only, never the key.
- `POST`/`PUT` accept a key, encrypt it immediately, and the response still
  omits it — the client already has what it typed, echoing it back serves
  no purpose and only adds exposure.
- `test connection` reuses the stored encrypted key server-side; the app
  never needs to resend a key to test it.

## 4. No secrets in logs or crash reports

- A **redaction middleware** wraps every log call and every outbound error
  payload; it pattern-matches common key shapes (`sk-...`, `Bearer ...`,
  long hex/base64 tokens) as a defense-in-depth backstop, in addition to
  the structural rule that decrypted keys never enter a variable that's
  in scope where logging happens (enforced by code review / lint rule
  banning `console.log`/logger calls inside `core/providers/*/index.ts`
  request-building functions without an explicit redaction wrapper).
- Crash reporting (if/when added) is configured to scrub request bodies for
  any route under `/providers/*/credentials`.
- `audit_log.metadata` is documented as **never** containing secret
  material — audit entries record *that* a key was added/rotated/tested,
  not the key.

## 5. Bounded self-modification (Evolution Engine)

Five change classes (`evolution_proposals.change_class`), each with a fixed
approval posture — the posture is a property of the class, not a per-proposal
judgment call, so it can't drift:

| Change class | Example | Approval |
|---|---|---|
| `knowledge_update` | New memory fact, updated research summary | Auto-applies |
| `model_registry_update` | New model discovered, health/availability refreshed | Auto-applies |
| `routing_policy_update` | Router weighting adjustment from outcome learning | Auto-applies, logged, reversible (previous weights retained) |
| `skill_update` | New/modified tool config or agent prompt/policy | Low-risk sub-changes auto-apply; anything touching a `requires_approval` tool or an agent's tool grants requires approval |
| `application_code_update` | Source code, infrastructure, or permission changes | **Always requires explicit user approval** — no exception |

Concretely: the Evolution Engine can propose and even sandbox-test an
`application_code_update`, but `evolution_proposals.status` cannot reach
`applied` for that class without a human hitting
`POST /evolution/proposals/:id/approve`. This is enforced at the data layer
(`requires_approval` is computed and stored `true` for that class
unconditionally when the proposal is created), not just in application
logic, so a bug in the Evolution Engine's own reasoning can't talk it into
skipping the gate.

Sandbox testing (`sandbox_result`) happens in an isolated environment
(separate container/DB, no access to real provider keys or the production
DB) before a proposal is even shown for approval — the user reviews a tested
diff, not raw intent.

## 6. Guardian Agent

`guardian` (see `04-agent-interfaces.md`) is the automated first check on
anything risky: it evaluates tool-approval requests and evolution proposals
against policy before either reaches the user, and can veto (mark
`denied`/`rejected`) but can never itself grant approval for a
`requires_approval` item — approval is a strictly human action. Guardian is
what keeps the human approval queue meaningful (low-noise) rather than
forwarding every tool call for manual review.

## 7. Self-healing without weakening security

Retries, circuit breakers, and provider fallback (see
`08-deployment-architecture.md` §4) operate entirely within already-granted
scope — a circuit breaker can stop calling a failing provider and fall back
to another *configured* one, but nothing in the self-healing path can grant
itself a new capability, credential, or tool grant. Recovery actions are
themselves `system`-sourced events on the event bus, so they're visible in
the Command Center and `audit_log`, not silent.

## 8. Privacy

- No third-party analytics/telemetry by default.
- No data leaves the Oracle Cloud instance except: (a) calls to the
  provider APIs the user configured, with only the minimum request content
  needed, and (b) push notification payloads to FCM (kept to a short
  human-readable summary, not full task content).
- Backups (see `08-deployment-architecture.md`) stay within the user's own
  Oracle Cloud Object Storage bucket.
