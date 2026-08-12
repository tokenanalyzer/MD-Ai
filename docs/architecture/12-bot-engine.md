# Bot Engine (M5)

Full type definitions: `packages/shared-types/src/bots`, `packages/shared-types/src/notifications`.

## 1. Scope and core principle

MD AI's backend must keep working when the Android app is closed. Bots are
the mechanism: deterministic, non-LLM background workers that detect
things and turn them into signals a human can act on.

**Core pipeline**: BOT DETECTS → FINDING → IMPORTANCE FILTER → AGENT
ANALYSIS WHEN NEEDED → REVIEW WHEN NEEDED → PUSH NOTIFICATION → USER.

Exactly four bots, per instruction: AI/Model Release Monitor, News
Monitor, User Topic Monitor, System Health Monitor. Explicitly **not**
built: crypto/stock trading bots, exchange execution, autonomous
financial actions, the 3D Command Center, n8n, OpenClaw, self-modifying
code, the Evolution Engine, or the full specialist-agent roster (Master/
Research/Reviewer — the M3 roster — is unchanged in M5).

## 2. Bot Registry (M5.1)

`core/bots/botRegistryService.ts` mirrors `AgentRegistryService`/
`ToolRegistryService` exactly: the `bots` table (migration `0020`) is the
source of truth for every bot's descriptive/mutable metadata (version,
category, status, capabilities, health, last run, last successful run,
failure count, timeout, owner, timestamps); the in-process `Map` holds
only the `BotDefinition` implementations this process actually registered
at boot (`index.ts`). No hardcoded bot list anywhere in the scheduler —
a bot with a DB row but no registered implementation is discoverable but
never dispatched to.

## 3. Bot Engine runtime (M5.2)

`core/bots/botEngine.ts`, built directly on the existing BullMQ
infrastructure (`queue/connection.ts`, the same
createQueue/createWorker/scheduleRepeatable shape as
`eventsRetentionJob.ts`/`healthRollupJob.ts`): one queue (`bot-engine`),
one bounded `Worker`, jobs named after bot ids. Deliberately **not** one
permanent process per bot — every bot's scheduled and run-once execution
flows through the same shared, concurrency-capped worker.

- **Scheduling**: `start()` reads every enabled bot's `schedule_cron` and
  registers a BullMQ repeatable job (`repeat: { pattern }`).
- **Run-once**: `runNow(botId)` (Bot Fleet's "Run now") adds a one-off job
  and awaits its completion via `QueueEvents`.
- **Timeout**: an `AbortController` is created per run and aborted after
  the bot's own `timeout_ms`; every bot that does network I/O (all four
  ship with one) passes this signal into its `fetch`/`safeFetch` calls, so
  a timeout genuinely interrupts in-flight work, not just the accounting.
- **Retry/backoff**: scheduled jobs use `attempts: 3`,
  `backoff: { type: "exponential", delay: 5000 }` — BullMQ's own retry
  mechanism, not custom code.
- **Recovery sweep**: a periodic pass (`listStuckBotRuns`) marks any
  `bot_runs` row still `running` past its bot's `timeout_ms` as `timeout`,
  so a crashed worker process can't leave a run "running" forever.
- **Cancellation**: implemented as the same abort mechanism as timeout —
  there is no separate user-facing "stop this run" control in M5. Given
  the four bots are short-lived (single HTTP calls or DB queries with
  their own bounded timeouts), a dedicated mid-run cancel path was judged
  unnecessary scope; noted here rather than silently omitted.

## 4. Resource control (M5.17)

Oracle target: 2 OCPU / 12GB, single user. Fixed, non-configurable bounds
so a misbehaving or misconfigured bot can never consume the box:

| Bound | Value |
|---|---|
| Max concurrent bot runs (process-wide) | 2 |
| Max runs per minute | 20 |
| Retry attempts (scheduled jobs) | 3 |
| Backoff base | 5s, exponential |
| Stuck-run sweep interval | 60s |

Verified against real Redis in `test/integration/botEngine.test.ts`
(four bots triggered simultaneously never exceed 2 concurrently running).

## 5. BotRun / BotFinding (M5.3/M5.4)

A `BotRun` records one execution: started/completed timestamps, duration,
status (`running`/`succeeded`/`failed`/`timeout`/`cancelled`), error
metadata, findings count, and resource metadata (counts/sizes — never a
raw response dump or a secret).

A `BotFinding` is **a signal, not a final AI answer**: category, title,
summary, importance, confidence, source metadata, a dedup key, and
escalation/notification status. `core/bots/pipeline.ts`'s
`processBotFindings()` is what a bot run's output flows through:

```
run() → NormalizedFinding[] → upsertFinding (dedup) → importance gate
  → escalateFinding() when the gate passes → notifyForFinding() → done
```

## 6. Deduplication (M5.5)

`bot_findings` has `UNIQUE(bot_id, dedup_key)`. `upsertFinding()` is a
single `INSERT ... ON CONFLICT DO UPDATE` that bumps `occurrence_count`/
`last_seen_at` on a repeat detection instead of inserting a new row. A
`cooldown_until` timestamp (set whenever a finding is acted on, scaled by
importance — 1h for CRITICAL down to 72h for LOW, in
`core/bots/dedup.ts`) suppresses re-escalation/re-notification for
repeat detections within the window, which is what keeps an AI release
visible across a day of 30-minute bot runs from producing dozens of
notifications — it produces exactly one per cooldown window.

## 7. Importance filter (M5.6)

A fixed LOW/MEDIUM/HIGH/CRITICAL ranking (`core/bots/dedup.ts`) is the
**only** gate on whether a finding triggers an LLM call at all —
evaluated with zero model calls, before Agent analysis is even
considered. `ESCALATION_MIN_IMPORTANCE = "medium"`: findings below that
never reach Master, only their own bot-authored title/summary.

## 8. The four bots (M5.7–M5.11)

| Bot | Category | Schedule | What it does |
|---|---|---|---|
| AI/Model Release Monitor | `ai_release` | every 30m | Fetches configured, owner-approved HTTPS sources returning a fixed `{ releases: [...] }` JSON shape — deliberately not an HTML/RSS scraper, so every reported release is something a source literally published in a structured field, never inferred. Empty `sources` (the seeded default) means zero findings, not zero function. |
| News Monitor | `news` | every 30m | Configured topics via the existing `SearchProvider` abstraction (M4.4) — no new integration. Deterministic filtering (title-match + recency heuristic) and URL-based dedup run before anything reaches an LLM. |
| User Topic Monitor | `user_topic` | every 15m | Owner-defined topics (`user_topics` table, each with its own frequency and importance threshold) — `listDueUserTopics()` only returns topics whose own cadence has elapsed, so a topic checked every 6h and one checked every 15m coexist inside one 15-minute bot tick. |
| System Health Monitor | `system_health` | every 5m | Six deterministic threshold checks: Postgres latency, Redis latency, host memory %, CPU load ratio, Bot Engine queue depth, enabled-model availability. Never an LLM judgment. |

None of these needed a "Guardian" capability tag to match a real agent —
the M3 roster (Master/Research/Reviewer) is unchanged in M5, and Master's
own synthesis (with or without delegating to Research) is what actually
produces the "Guardian/Health analysis" language in the milestone
instruction functionally, without building a new specialist agent.

## 9. Agent escalation (M5.12)

`core/bots/escalation.ts`'s `escalateFinding()` dispatches into **the
same entry point a chat message uses**: `buildRuntimeContext` +
`master.handleTask()`, awaited to completion (there's no WS client to
stream to). Master does its own intent classification and
capability-based delegation via the Agent Registry internally (M3) — a
bot finding never gets a bot-specific routing shortcut that could bypass
`agent_delegation_edges`/`agent_tool_grants`.

Where the credentials come from is the one genuinely new piece: see §11
below.

## 10. Push notifications + preferences (M5.13/M5.14)

`core/notifications/notificationService.ts`'s `notifyForFinding()` is the
pipeline's terminal step, called for every finding that passed dedup
(new or cooldown-expired). It always creates a `notifications` row, then
evaluates the owner's preferences in order: `enabled` →
`minimum_importance` → muted category/bot/topic → quiet hours → device
availability. A suppression is recorded with a specific reason
(`below_threshold`/`category_filtered`/`bot_filtered`/`topic_filtered`/
`quiet_hours`/`no_device`/`disabled`), never silently dropped.

### 10.1 Delivery mechanism

"Oracle → notification service → FCM → Android → user," concretely:
`core/notifications/expoPushSender.ts` calls Expo's push service
(`exp.host`), which relays to FCM for Android devices — this is the
standard delivery path in an Expo-managed workflow and avoids a separate
Firebase Admin SDK/service-account credential on the backend. The mobile
app registers a push token via `expo-notifications` and reports it to
`POST /auth/push-token`; `device_sessions.push_token` already existed
from M1's schema.

### 10.2 Preferences default

`notification_preferences` defaults to `minimum_importance = 'high'`,
no quiet hours, nothing muted — "default conservative" per instruction: a
fresh install sends nothing below HIGH until the owner explicitly loosens
it.

## 11. Bot Command Center events (M5.15)

`bot.registered`, `bot.started`, `bot.run.started`, `bot.run.completed`,
`bot.failed`, `bot.paused`, `bot.resumed`, `bot.finding.created`,
`bot.finding.deduplicated`, `bot.finding.escalated`,
`bot.notification.sent`, `bot.notification.failed` — added to the shared
`EventPayload` union (`05-event-schemas.md`). Metadata-only, same
guarantee as every other event family in this codebase.

## 12. Mobile Bot Fleet screen (M5.16)

`apps/mobile/app/(bots)` — explicitly **not** the 3D Command Center.
Every registered bot with status/health, last/last-successful run,
failure count, and an expandable detail view of recent findings and
runs. Enable/disable, pause/resume, run-now. Reuses the existing
NVIDIA-inspired theme tokens and the Vault screen's card layout — no new
design system.

## 13. Opt-in background credential vault (M5.12a)

**The tension this closes**: `07-security-model.md` §3 established that
the backend never holds a provider API key by default — keys live in the
Android app's Keystore-backed vault and travel per-request. §3.4
explicitly anticipated the gap this creates: *"any bot/automation that
needs an LLM call simply cannot run unattended... until an explicitly
opt-in server secret mechanism is built."* M5's success criteria requires
exactly that unattended path (a finding analyzed and notified while the
app is closed), so this milestone builds the mechanism §3.4 described —
as a **separate**, explicitly opt-in table, never folded into
`provider_configs`.

- `background_credentials` (migration `0020`): `(credential_kind,
  credential_id)` primary key, covering both `llm_provider` (for
  escalation) and `search_provider` (for News/User Topic Monitor
  searches) — one mechanism for both credential families that already
  travel per-request everywhere else in the system (`providerKeys`/
  `toolKeys`).
- Envelope AES-256-GCM (`core/security/backgroundKeyVault.ts`): a random
  per-credential DEK encrypts the value; the DEK is wrapped under a
  single process KEK from `MDAI_BACKGROUND_KEY_KEK` (env only, never in
  Postgres). Optional at the env-schema level — most deployments never
  opt anything in — but every encrypt/decrypt call fails clearly
  (`BackgroundKeyVaultNotConfiguredError`) if the KEK is absent.
- `PUT /background-credentials` is the only endpoint in the entire API
  that accepts a credential and stores a durable copy server-side, and it
  only does so for the exact `(credentialKind, credentialId)` the owner
  named. `GET` returns metadata only (kind, id, last-4, opt-in
  timestamp); `DELETE` revokes by deleting the row — the DEK/ciphertext
  leave with it.
- Absent by default, and gracefully so: with nothing opted in, bot
  escalation and search calls that need a credential simply skip (no
  agent analysis, or a `web_search`-style honest unavailability) —
  exactly the "must remain disabled gracefully" pattern M5.0 established
  for the second `SearchProvider`.

See `07-security-model.md` §11 for the full security-guarantee summary
and test coverage.

## 14. Sequence: a finding that gets escalated and notified

```
System Health Monitor (bot_engine worker)
  → SELECT 1 / PING / os.loadavg() / queue.getJobCounts() [deterministic]
  → threshold breach → NormalizedFinding{importance: "critical"}
core/bots/pipeline.ts
  → upsertFinding()                         [dedup: new row or bumped occurrence]
  → bot.finding.created                     [event]
  → meetsImportanceThreshold("critical", "medium") === true
  → escalateFinding()
      → buildBackgroundProviderKeys()       [opt-in vault, decrypt only for this call]
      → createTask(assignedAgentId: "master", taskType: "bot_escalation")
      → buildRuntimeContext() + master.handleTask()   [same path as chat]
      → Master classifies, may delegate to Research, synthesizes text
  → bot.finding.escalated                   [event]
  → notifyForFinding()
      → getOrCreateNotificationPreferences() [owner-controlled filtering]
      → sender.send() → Expo push service → FCM → Android
  → bot.notification.sent                   [event]
  → cooldown_until set (1h for CRITICAL)     [M5.5 — next detection within the hour is absorbed silently]
```
