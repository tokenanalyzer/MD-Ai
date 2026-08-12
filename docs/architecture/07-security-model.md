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

**Not implemented yet — do not confuse with M3's Reviewer.** `reviewer`
(§9 below) validates a specialist agent's *output quality* (completeness,
contradictions, hallucination risk) before it reaches Master; it has no
opinion on tool-approval or evolution-proposal *policy*, which is
Guardian's job. The two are separate future/present agents with disjoint
responsibilities, not the same agent under two names.

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

## 9. M3: multi-agent security guarantees

Delegating work to Research and having Reviewer validate it before Master
answers introduces new places a mistake could leak a secret, let an agent
overreach, or quietly rubber-stamp bad output. M3 closes each of these
structurally, not by convention:

- **No provider key anywhere in the delegation tree.** `providerKeys`
  lives only in the request handler's closure (`api/routes/conversations.ts`
  → `dispatchMasterAgentTask` → `buildRuntimeContext`), exactly as in §3.2
  — delegating to Research/Reviewer doesn't add a second place a key could
  be written, because child tasks never receive `providerKeys` in their
  `input` at all; they reach the Model Router through the same
  in-closure reference the root task uses. Verified end-to-end by
  `services/backend/test/integration/m3Security.test.ts`, which runs a
  full Master → Research → Reviewer chat and asserts a known fake key
  never appears in `tasks`, `events`, `memory_items`, `task_messages`, or
  captured log output.
- **Delegation requires an explicit authorization row.** `delegate()`
  (`core/agents/runtimeContext.ts`) checks
  `agentRegistry.isDelegationAuthorized(fromAgentId, toAgentId)` — backed
  by the `agent_delegation_edges` table (data, not code) — before
  creating a child task, and throws `DelegationNotAuthorizedError`
  otherwise. M3's seed data authorizes only `master → research` and
  `master → reviewer`; Research and Reviewer have no outbound edges at
  all, so neither can delegate to anything, including each other.
- **Reviewer can never approve itself.** `reviewerAgent.ts` structurally
  refuses any task whose `input.targetAgentId === "reviewer"` before
  making a single model call — `finishFailure({ code:
  "reviewer_cannot_review_self" })`. This is checked ahead of, not
  instead of, the delegation-authorization check above (belt and
  suspenders: even if a future bug ever authorized `reviewer → reviewer`,
  this guard still refuses).
- **`agent_progress` status text is always safe, never chain-of-thought.**
  Every `TaskStreamChunk{ kind: "agent_progress" }` Master or a delegated
  agent emits is a short, hardcoded-shape label (e.g. "Research Agent
  working…", built from `AgentCard.displayName`) — never a fragment of a
  model's raw output or reasoning trace. The Android chat UI renders this
  `label` directly as-is with no additional parsing, which is only safe
  because the backend guarantees its content, not because the client
  sanitizes it.
- **Memory content never crosses the event bus.** `memory.retrieved`
  carries a `count` and a `memoryIds` array only; `memory.created` carries
  `category`/`approvalStatus`, not `content`. A future Command Center can
  render "3 memories retrieved" without the event bus itself becoming a
  second place memory content is exposed beyond the authenticated
  `/memory` REST routes.
- **A system-proposed memory candidate cannot become retrievable without a
  human decision.** §"Approval policy" in `04-agent-interfaces.md` §7 —
  enforced at the query layer (`searchMemory`'s `WHERE approval_status =
  'approved'`), not by trusting every write path to set the right flag.

## 10. M4: MCP tool layer security guarantees

Full detail (SSRF protection internals, the permission table, the prompt
injection trust-boundary design) lives in `11-mcp-tools.md` §7 — this
section is the security-model-level summary and the list of what's
verified where.

- **No tool credential (`toolKeys`) is ever persisted or logged**, same
  guarantee and same mechanism as `providerKeys` (§3.2): held only in the
  request handler's closure, passed into `ToolExecutionContext.toolKeys`,
  never written to `tool_invocations.input`, never included in any
  `tool.*` event. Verified by `test/integration/mcpHostSecurity.test.ts`
  and the whole-delegation-tree sweep in
  `test/integration/m3Security.test.ts`.
- **Every tool call passes an explicit permission check before
  execution** — `mcpHost.invokeTool()` checks `agent_tool_grants` (data,
  not code, same "absence is denial" pattern as `agent_delegation_edges`)
  before creating an invocation row; a denial publishes `tool.blocked` and
  throws, never silently no-ops. Verified by
  `test/integration/mcpHostSecurity.test.ts`'s permission-bypass case.
- **SSRF protection is real and tested**, not just described: HTTPS-only,
  private/loopback/link-local IP blocking (which also covers the
  `169.254.169.254` cloud metadata endpoint shared by AWS/GCP/Azure/OCI),
  known metadata hostnames blocked by name, and every redirect hop
  re-validated (a redirect to a private IP is refused exactly like a
  direct request to one). **DNS-rebinding is closed (M5.0)**: a
  connect-time `undici` dispatcher (`core/security/ssrfSafeDispatcher.ts`,
  installed process-wide at boot) re-validates the resolved address as
  the *same operation* Node uses to open the socket, so there is no
  window between "checked" and "connected" for a DNS record to change
  in. See `11-mcp-tools.md` §7.1 and `test/unit/ssrfGuard.test.ts` /
  `test/unit/safeFetch.test.ts` / `test/unit/ssrfSafeDispatcher.test.ts` /
  `test/integration/ssrfDnsRebinding.test.ts` for the exact coverage.
- **Prompt injection has two independent layers**, not reliance on a
  single mitigation: (1) retrieved tool content is always wrapped in
  explicit "UNTRUSTED EXTERNAL CONTENT" markers with an instruction never
  to treat it as authoritative, and (2) structurally, a tool's output can
  only ever become inert text fed through `extractJson()` — there is no
  code path that lets a tool result trigger another tool call, change a
  permission, or alter routing. `test/unit/promptInjectionDefense.test.ts`
  verifies both: the markers are actually constructed correctly, and a
  page that explicitly tries to invoke `generic_http_get` and exfiltrate
  credentials results in exactly the two tool calls the agent's own code
  made — never a third. Whether a *given* LLM actually resists a crafted
  payload depends on the model itself, which this codebase cannot
  control or verify — the tests prove construction and structural
  containment, not model behavior.
- **`generic_http_get` cannot be used to invent or forward a credential**
  — its input schema has no `headers`/`authorization` field at all, so
  there is nothing for a model to fill in even if it tried.
- **The anti-hallucination source guard closes the "trust the model's own
  citation" gap.** Research Agent never accepts a `source` URL the model
  merely *claims* — only URLs actually present in this turn's retrieved
  search/read results are accepted; anything else is stripped and the
  finding downgraded to `"uncertain"`. Verified end-to-end with a mocked
  model response that tries to sneak in a fabricated citation
  (`test/integration/researchTools.test.ts`).
- **Every tool result is bounded** (`core/mcp/tools/resultLimits.ts`,
  `safeFetch`/`safeFetchBinary`'s streamed `maxBytes`) — no oversized page
  or file content reaches an LLM context or gets buffered unbounded in
  memory.
