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
| Provider key theft via DB dump | Structurally impossible by default — the backend never writes a provider key to any table (see §3). A DB dump contains, at most, connection metadata and a last-4 display fragment. |
| Provider key theft via logs/crash reports | Structural redaction — see §4 |
| Provider key theft in transit (device ↔ backend) | TLS-only backend (see `08-deployment-architecture.md`); keys travel only inside authenticated, TLS-protected requests, never as URL query params |
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

**The backend is not the vault. The Android app is.** This is a product
requirement, not just an implementation choice: the owner enters and
controls their own provider keys from the phone, and the backend must not
be the authoritative holder of that secret by default.

### 3.1 Where keys actually live

- **On-device storage**: `expo-secure-store`, which on Android is backed by
  the **Android Keystore** — the key material is protected by the device's
  hardware-backed keystore, not just app-sandboxed storage. This is the one
  and only persistent store for provider keys in the default architecture.
- **Backend storage**: none. `provider_configs` (see `02-database-schema.md`
  §1) has no ciphertext column, no DEK, no KEK — there is nothing there to
  decrypt because there is nothing there.

### 3.2 How the backend uses a key without storing it

1. The app reads the key from `expo-secure-store` at the moment it's
   needed (sending a chat message, testing a connection).
2. It's attached to that one HTTPS/WebSocket request — `providerKeys` on
   the chat message contract, `apiKey` on the test-connection call (see
   `03-api-contracts.md` §2–3).
3. The backend's request handler passes it straight into the relevant
   `ModelProvider` adapter call and lets the reference go out of scope the
   moment that call (or stream) completes. It is never assigned to a
   variable outside that request's handling function, never put in a
   session object, never put in a cache, never written to Postgres or
   Redis.
4. The only durable trace left behind is non-secret metadata: connection
   `status`, `last_test_at`/`last_test_error`, and a `key_last4` fragment
   computed from the transient value purely for display (e.g. "NVIDIA
   ...a91f") — none of which allow reconstructing the key.

This is enforced structurally, not just by convention: the `ModelProvider`
interface (`06-provider-model-interfaces.md` §1) takes `apiKey` as a plain
call argument, not as adapter construction state, so there is no object in
the process that could accumulate keys across requests even if someone
tried.

### 3.3 API surface guarantees (`03-api-contracts.md` §3)

- There is no endpoint that stores a key server-side — by design, not by
  omission. `POST /providers/:id/test-connection` accepts a key and uses
  it once; there is no corresponding "save" endpoint.
- `GET .../configs` responses have no `apiKey` field in their type at all
  (not "omitted", the field doesn't exist on `ProviderConfig`).
- `key_last4` is computed from whatever was `POST`ed to
  `test-connection` in that call, then discarded along with the rest of
  the key.

### 3.4 Future: an explicitly opt-in server secret mechanism (not built yet)

Some future capability may genuinely need the backend to call a provider
with no device present — e.g. a bot that must run at 3am. When that need
is real, it will be built as a **separate mechanism**, deliberately not
routed through this vault design:

- A distinct table (not `provider_configs`) that the owner opts into
  per-provider, with its own explicit UI flow ("allow the backend to hold
  a copy of this key for background use") — not a silent default.
- Envelope encryption (DEK/KEK, as originally scoped for this milestone)
  is the right storage design *for that table specifically*, since it
  would be a genuine server-side secret at that point.
- Until that mechanism exists, any bot/automation that needs an LLM call
  simply cannot run unattended — see `01-repository-structure.md` §3 and
  `00-overview.md` §2 principle 1 for the resulting scope boundary on
  background execution.

## 4. No secrets in logs or crash reports

- The structured logger is configured with an explicit **redaction path
  list** (`req.body.providerKeys`, `req.body.apiKey`,
  `req.headers.authorization`, and any nested `parts[].data.apiKey`-shaped
  field) so request/response logging middleware can never emit them,
  regardless of log level — this is a config-level guarantee (the logger
  library redacts before serialization), not a per-call discipline that
  can be forgotten.
- A **pattern-matching backstop** additionally scrubs common key shapes
  (`sk-...`, `Bearer ...`, long hex/base64 tokens) from any log line and
  outbound error payload that didn't go through the structured logger, as
  defense-in-depth.
- Crash reporting (if/when added) is configured to scrub request bodies for
  `/providers/*/test-connection` and `/conversations/*/messages`.
- `audit_log.metadata` is documented as **never** containing secret
  material — audit entries record *that* a connection was tested or a
  chat request was routed to a given provider, not any key.
- This guarantee is covered by an automated test (see M1 test suite,
  `docs/architecture/09-roadmap.md`) that sends a request containing a
  known fake key and asserts the key substring never appears in captured
  log output.
- **M2 telemetry is metadata-only by construction.** `model_call_samples`
  (docs/architecture/06-provider-model-interfaces.md §5) records latency,
  success/failure, token *counts*, and status codes — values computed from
  response metadata, never from the request/response bodies themselves.
  There is no code path from a chat prompt or completion into a telemetry
  row; `services/backend/test/integration/modelRegistry.test.ts` asserts a
  recorded sample never matches a provider-key-shaped substring.

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
to another provider **whose key was already present in that same request's
`providerKeys`**, but nothing in the self-healing path can grant itself a
new capability, credential, or tool grant, and it can never reach for a key
the request didn't supply. Recovery actions are
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
