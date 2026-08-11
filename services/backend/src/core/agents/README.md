# core/agents

Agent Registry + one directory per agent, each implementing `Agent`
(`@mdai/shared-types`). See `docs/architecture/04-agent-interfaces.md` for
the full roster and the Master Agent's delegation flow.

Planned agent directories (created starting M1/M3/M8 per
`docs/architecture/09-roadmap.md`): `master/`, `research/`, `crypto-intel/`,
`stock-intel/`, `business-intel/`, `social-media/`, `ai-radar/`,
`news-intel/`, `reviewer/`, `guardian/`, `memory-agent/`.

Delegation relationships are **data** (`agent_delegation_edges` table), not
code in this directory — do not add a hard-coded routing map here.
