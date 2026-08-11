# core/evolution

Evolution Engine: model/tool discovery sweeps, benchmarking, outcome-based
routing updates, and the `evolution_proposals` pipeline (sandbox test →
approval gate → apply/rollback). `application_code_update` and
approval-required `skill_update` proposals can never auto-apply — enforced
at the data layer, not just here. See
`docs/architecture/07-security-model.md` §5 and
`docs/architecture/09-roadmap.md` (M9).
