import type { EvolutionChangeClass } from "../../db/repositories/evolutionProposalRepo.js";

/**
 * The fixed approval posture per change class
 * (`docs/architecture/07-security-model.md` §5) — a property of the
 * class, not a per-proposal judgment call, so it can't drift:
 *
 * | Class                     | Approval                                    |
 * |----------------------------|----------------------------------------------|
 * | knowledge_update           | Auto-applies                                  |
 * | model_registry_update      | Auto-applies                                  |
 * | routing_policy_update      | Auto-applies (reversible — prior value kept)  |
 * | skill_update                | Auto-applies unless it touches a              |
 * |                             | `requires_approval` tool or an agent's        |
 * |                             | tool grants                                    |
 * | application_code_update    | **Always** requires approval — no exception   |
 *
 * M9 ships no autonomous producer for `knowledge_update`/`skill_update`
 * (no organic signal source exists for either yet — see
 * `core/evolution/README.md`); this function still computes their posture
 * correctly for whenever a proposal of that class exists (tests, or a
 * future producer), since `application_code_update`'s "no exception" rule
 * is the one piece of this table that must never regress.
 */
export function computeRequiresApproval(
  changeClass: EvolutionChangeClass,
  opts: { touchesRestrictedToolOrGrant?: boolean } = {},
): boolean {
  switch (changeClass) {
    case "application_code_update":
      return true;
    case "skill_update":
      return opts.touchesRestrictedToolOrGrant === true;
    case "knowledge_update":
    case "model_registry_update":
    case "routing_policy_update":
      return false;
  }
}
