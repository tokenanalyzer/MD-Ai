import { Router } from "express";
import type pg from "pg";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { decideToolApprovalBodySchema } from "../schemas.js";
import { decideToolInvocation, getToolInvocation, listToolInvocationsByStatus } from "../../db/repositories/toolRepo.js";
import { writeAuditLog } from "../../db/repositories/auditLogRepo.js";
import type { ToolRegistryService } from "../../core/mcp/toolRegistryService.js";
import type { EventBus } from "../../core/events/eventBus.js";
import { resumeApprovedToolInvocation } from "../../core/mcp/mcpHost.js";

/** Read-only discovery — tool health/enablement is managed by the Tool Registry itself, not by hand-editing through this API in M4. */
export function toolsRouter(pool: pg.Pool, toolRegistry: ToolRegistryService, eventBus: EventBus): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res, next) => {
    try {
      const tools = await toolRegistry.list();
      res.json({ data: tools });
    } catch (err) {
      next(err);
    }
  });

  // M8: invocations Guardian left `awaiting_approval` for a human decision
  // — see core/mcp/mcpHost.ts's approval gate and core/agents/guardian/
  // policy.ts. Guardian itself can only `deny` or forward as `pending`;
  // only a human request through this route can move a row to `approved`.
  router.get("/approvals", async (_req, res, next) => {
    try {
      const rows = await listToolInvocationsByStatus(pool, "awaiting_approval");
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          toolId: r.tool_id,
          agentId: r.agent_id,
          taskId: r.task_id ?? undefined,
          input: r.input,
          createdAt: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // M9: on "approved", actually replays the original call via
  // `resumeApprovedToolInvocation` — closing the gap M8 left open (a
  // decision alone used to be the end of the story). A resumed call can
  // legitimately fail/timeout just like a fresh one; that's not an HTTP
  // error here, it's the invocation's own real outcome — the response
  // always reflects the invocation's actual final status, fetched fresh
  // after the resume attempt.
  router.post("/approvals/:invocationId/decide", async (req, res, next) => {
    try {
      const { decision, toolKeys } = decideToolApprovalBodySchema.parse(req.body);
      const invocationId = req.params.invocationId as string;

      const updated = await decideToolInvocation(pool, invocationId, decision);
      if (!updated) {
        throw AppError.notFound(`No tool invocation ${invocationId} is currently awaiting approval`);
      }

      await writeAuditLog(pool, {
        actor: "user",
        action: `tool_approval.${decision}`,
        targetType: "tool_invocation",
        targetId: invocationId,
        metadata: { toolId: updated.tool_id, agentId: updated.agent_id },
      });

      if (decision === "approved") {
        try {
          await resumeApprovedToolInvocation({ pool, eventBus, toolRegistry }, invocationId, toolKeys ?? {});
        } catch {
          // The resumed call's own outcome (failed/timeout/blocked) is
          // already recorded on the invocation row by runToolHandler —
          // nothing further to do here except report that real outcome.
        }
      }

      const final = await getToolInvocation(pool, invocationId);
      res.json({ data: { id: invocationId, status: final?.status ?? updated.status } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
