import type { EvolutionChangeClass } from "../../db/repositories/evolutionProposalRepo.js";

/**
 * `applyEvolutionProposal` throws this for `skill_update` and
 * `application_code_update` unconditionally — including after a human has
 * approved them. Neither has an automatic applier in this codebase: there
 * is no data-modeled "skill" to mutate (agent prompts/policy are source
 * code today, not a DB row) and, by explicit design, nothing in this
 * system ever autonomously deploys a source-code/infrastructure change —
 * "Evolution must never silently self-approve or deploy its own changes."
 * A human approving one of these records an authoritative decision; acting
 * on it (writing the actual code, deploying it) is a deliberate manual
 * step outside this system, never triggered by this function.
 */
export class NoEvolutionApplierError extends Error {
  constructor(readonly changeClass: EvolutionChangeClass) {
    super(
      `No automatic applier exists for change class "${changeClass}" — this is by design, not a missing feature. ` +
        `Approval (if any) is recorded, but applying/deploying this change is a manual step outside the system.`,
    );
    this.name = "NoEvolutionApplierError";
  }
}
