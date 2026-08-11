# core/bots

Bot Engine: scheduler (BullMQ-backed) + one directory per bot, each
implementing `BotDefinition` (`@mdai/shared-types`). Bots are deterministic
— no model calls. A bot run produces `BotFinding`s; the engine escalates
findings to `bots.escalate_to_agent_id` as a new `Task`, which is the only
hand-off point into the agent world. See
`docs/architecture/01-repository-structure.md` §1 (BOT DETECTS → AGENT
ANALYZES → REVIEWER VALIDATES → MASTER REPORTS) and
`docs/architecture/04-agent-interfaces.md` §6.

Planned bot directories (M5/M8): `market-scanner/`, `price-monitor/`,
`liquidity-monitor/`, `volume-anomaly-monitor/`, `news-monitor/`,
`model-release-monitor/`, `social-trend-monitor/`,
`business-opportunity-monitor/`, `notification-worker/`.
