import { Router } from "express";
import type pg from "pg";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { createAutomationBodySchema, patchAutomationBodySchema } from "../schemas.js";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  updateAutomation,
  type AutomationRow,
} from "../../db/repositories/automationRepo.js";
import { listRecentAutomationRuns } from "../../db/repositories/automationRunRepo.js";
import { revokeBackgroundCredential, upsertBackgroundCredential } from "../../db/repositories/backgroundCredentialRepo.js";
import { encryptCredential, last4 } from "../../core/security/backgroundKeyVault.js";
import { generateWebhookSecret, generateWebhookSlug } from "../../core/automations/webhookSignature.js";
import type { AutomationEngine } from "../../core/automations/automationEngine.js";

function toDto(row: AutomationRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config,
    actionType: row.action_type,
    actionConfig: row.action_config,
    enabled: row.enabled,
    createdBy: row.created_by,
    lastRunAt: row.last_run_at?.toISOString(),
    webhookSlug: row.webhook_slug,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * M10 `automations` REST surface (docs/architecture/03-api-contracts.md
 * §7). The signed `POST /webhooks/automations/:slug` endpoint is a
 * SEPARATE router (`webhooksRouter`, `api/routes/webhooks.ts`) mounted
 * without `authGuard` — everything here requires the normal device bearer
 * token.
 */
export function automationsRouter(pool: pg.Pool, automationEngine: AutomationEngine | undefined): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res, next) => {
    try {
      const rows = await listAutomations(pool);
      res.json({ data: rows.map(toDto) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = createAutomationBodySchema.parse(req.body);

      let webhookSlug: string | undefined;
      let webhookSecret: string | undefined;
      if (body.triggerType === "webhook") {
        webhookSlug = generateWebhookSlug();
        webhookSecret = generateWebhookSecret();
      }

      const row = await createAutomation(pool, {
        name: body.name,
        description: body.description,
        triggerType: body.triggerType,
        triggerConfig: body.triggerConfig,
        actionType: body.actionType,
        actionConfig: body.actionConfig,
        timeoutMs: body.timeoutMs,
        webhookSlug,
        createdBy: "user",
      });

      if (webhookSecret) {
        const encrypted = encryptCredential(webhookSecret);
        await upsertBackgroundCredential(pool, "automation_webhook", row.id, encrypted, last4(webhookSecret));
      }

      res.status(201).json({
        data: {
          ...toDto(row),
          // Shown exactly once — the same "reveal only at creation" convention
          // as a provider API key. Not retrievable again; deleting and
          // recreating the automation is the only way to rotate it today.
          webhookSecret: webhookSecret ?? undefined,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const row = await getAutomation(pool, req.params.id as string);
      if (!row) throw AppError.notFound(`Automation ${req.params.id} not found`);
      res.json({ data: toDto(row) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/runs", async (req, res, next) => {
    try {
      const rows = await listRecentAutomationRuns(pool, req.params.id as string, 20);
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          automationId: r.automation_id,
          startedAt: r.started_at.toISOString(),
          finishedAt: r.finished_at?.toISOString(),
          status: r.status,
          result: r.result,
          error: r.error,
          triggerType: r.trigger_type,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const existing = await getAutomation(pool, req.params.id as string);
      if (!existing) throw AppError.notFound(`Automation ${req.params.id} not found`);
      const body = patchAutomationBodySchema.parse(req.body);
      const updated = await updateAutomation(pool, existing.id, body);
      res.json({ data: toDto(updated!) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const existing = await getAutomation(pool, req.params.id as string);
      if (!existing) throw AppError.notFound(`Automation ${req.params.id} not found`);
      if (existing.webhook_slug) {
        await revokeBackgroundCredential(pool, "automation_webhook", existing.id);
      }
      await deleteAutomation(pool, existing.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/run", async (req, res, next) => {
    try {
      const existing = await getAutomation(pool, req.params.id as string);
      if (!existing) throw AppError.notFound(`Automation ${req.params.id} not found`);
      if (!automationEngine) {
        throw AppError.serviceUnavailable(
          "Automation Engine is unavailable — REDIS_URL is not configured on this backend",
        );
      }
      const run = await automationEngine.runNow(existing.id, "manual");
      res.status(202).json({
        data: {
          id: run.id,
          automationId: run.automation_id,
          status: run.status,
          result: run.result,
          error: run.error,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
