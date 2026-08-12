import { Router } from "express";
import type pg from "pg";
import type { MemoryEngine, ModelRegistry } from "@mdai/shared-types";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import type { EventBus } from "../../core/events/eventBus.js";
import {
  decideProposal,
  getProposal,
  listProposals,
  type EvolutionProposalRow,
  type EvolutionProposalStatus,
} from "../../db/repositories/evolutionProposalRepo.js";
import { writeAuditLog } from "../../db/repositories/auditLogRepo.js";
import { applyEvolutionProposal } from "../../core/evolution/applyProposal.js";
import { NoEvolutionApplierError } from "../../core/evolution/errors.js";
import { runEvolutionSweep } from "../../core/evolution/producer.js";

function toDto(row: EvolutionProposalRow) {
  return {
    id: row.id,
    changeClass: row.change_class,
    title: row.title,
    rationale: row.rationale,
    diff: row.diff,
    riskLevel: row.risk_level,
    requiresApproval: row.requires_approval,
    status: row.status,
    sandboxResult: row.sandbox_result,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at?.toISOString(),
    appliedAt: row.applied_at?.toISOString(),
    rolledBackAt: row.rolled_back_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

const VALID_STATUS_FILTERS: EvolutionProposalStatus[] = [
  "proposed",
  "sandbox_tested",
  "approved",
  "rejected",
  "applied",
  "rolled_back",
];

/**
 * M9 Evolution Engine surface: read-only listing/detail, a manual sweep
 * trigger (mirrors the Bot Engine's `run-now`), and the human
 * approve/reject actions that are the only way a `requires_approval`
 * proposal ever moves past `sandbox_tested` — Guardian and the sweep
 * producer can only deny or auto-apply an already-not-requiring-approval
 * proposal (`core/evolution/reviewAndApply.ts`), never grant approval
 * themselves.
 */
export function evolutionRouter(pool: pg.Pool, eventBus: EventBus, modelRegistry: ModelRegistry, memoryEngine: MemoryEngine): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/proposals", async (req, res, next) => {
    try {
      const statusParam = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
      const status =
        statusParam && VALID_STATUS_FILTERS.includes(statusParam as EvolutionProposalStatus)
          ? (statusParam as EvolutionProposalStatus)
          : undefined;
      const rows = await listProposals(pool, status);
      res.json({ data: rows.map(toDto) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/proposals/:id", async (req, res, next) => {
    try {
      const row = await getProposal(pool, req.params.id as string);
      if (!row) throw AppError.notFound(`Evolution proposal ${req.params.id} not found`);
      res.json({ data: toDto(row) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/proposals/:id/approve", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const existing = await getProposal(pool, id);
      if (!existing) throw AppError.notFound(`Evolution proposal ${id} not found`);
      if (!existing.requires_approval) {
        throw AppError.badRequest(`Proposal ${id} (${existing.change_class}) does not require approval — it either already auto-applied or was denied by Guardian.`);
      }
      if (!["proposed", "sandbox_tested"].includes(existing.status)) {
        throw AppError.badRequest(`Proposal ${id} is "${existing.status}" — only a "proposed" or "sandbox_tested" proposal can be approved.`);
      }

      const decided = await decideProposal(pool, id, "approved");
      await writeAuditLog(pool, {
        actor: "user",
        action: "evolution_proposal.approved",
        targetType: "evolution_proposal",
        targetId: id,
        metadata: { changeClass: decided.change_class },
      });
      await eventBus.publish({
        sourceType: "system",
        sourceId: id,
        payload: { type: "evolution.proposal.approved", proposalId: id, changeClass: decided.change_class },
      });

      // Applying (if this class has a real applier) is a direct, immediate
      // consequence of THIS human action — never automatic on its own.
      // `application_code_update`/`skill_update` have no applier by
      // design (see `NoEvolutionApplierError`); approval still succeeds,
      // it just leaves the proposal at "approved" for a human to act on
      // outside the system.
      let final = decided;
      try {
        final = await applyEvolutionProposal({ pool, modelRegistry, memoryEngine }, decided);
        await writeAuditLog(pool, {
          actor: "user",
          action: "evolution_proposal.applied",
          targetType: "evolution_proposal",
          targetId: id,
          metadata: { changeClass: final.change_class },
        });
        await eventBus.publish({
          sourceType: "system",
          sourceId: id,
          payload: { type: "evolution.proposal.applied", proposalId: id, changeClass: final.change_class, appliedBy: "user" },
        });
      } catch (err) {
        if (!(err instanceof NoEvolutionApplierError)) throw err;
      }

      res.json({ data: toDto(final) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/proposals/:id/reject", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const existing = await getProposal(pool, id);
      if (!existing) throw AppError.notFound(`Evolution proposal ${id} not found`);
      if (!existing.requires_approval) {
        throw AppError.badRequest(`Proposal ${id} (${existing.change_class}) does not require approval — it either already auto-applied or was denied by Guardian.`);
      }
      if (!["proposed", "sandbox_tested"].includes(existing.status)) {
        throw AppError.badRequest(`Proposal ${id} is "${existing.status}" — only a "proposed" or "sandbox_tested" proposal can be rejected.`);
      }

      const decided = await decideProposal(pool, id, "rejected");
      await writeAuditLog(pool, {
        actor: "user",
        action: "evolution_proposal.rejected",
        targetType: "evolution_proposal",
        targetId: id,
        metadata: { changeClass: decided.change_class },
      });
      await eventBus.publish({
        sourceType: "system",
        sourceId: id,
        payload: { type: "evolution.proposal.rejected", proposalId: id, changeClass: decided.change_class, decidedBy: "user" },
      });

      res.json({ data: toDto(decided) });
    } catch (err) {
      next(err);
    }
  });

  // Manual trigger — mirrors the Bot Engine's POST /bots/:id/run-now. The
  // same sweep also runs on `queue/evolutionSweepJob.ts`'s schedule.
  router.post("/sweep", async (_req, res, next) => {
    try {
      const summary = await runEvolutionSweep({ pool, eventBus, modelRegistry, memoryEngine });
      res.status(202).json({ data: summary });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
