import { Router } from "express";
import type pg from "pg";
import { AppError } from "../errors.js";
import { getAutomationByWebhookSlug } from "../../db/repositories/automationRepo.js";
import { getBackgroundCredential, toEncryptedCredential } from "../../db/repositories/backgroundCredentialRepo.js";
import { decryptCredential } from "../../core/security/backgroundKeyVault.js";
import { getSignatureHeader, verifyWebhookSignature } from "../../core/automations/webhookSignature.js";
import type { AutomationEngine } from "../../core/automations/automationEngine.js";

/**
 * M10: `POST /webhooks/automations/:slug` — the one deliberate exception
 * to "every route requires the device bearer token"
 * (docs/architecture/07-security-model.md §2). The caller (e.g. an n8n
 * workflow) isn't the paired device, so it authenticates with an
 * HMAC-SHA256 signature over the raw request body instead, using a secret
 * only this automation's creator (via `POST /automations`) and the
 * configured external caller know. `webhook_slug` alone is a routing
 * token, never sufficient on its own — a request with a valid slug but a
 * missing/wrong signature is refused exactly like one with no slug at all.
 *
 * NOT mounted under `authGuard` — this is the entire router, kept
 * separate from `automationsRouter` so that omission is structural, not a
 * per-route judgment call.
 */
export function webhooksRouter(pool: pg.Pool, automationEngine: AutomationEngine): Router {
  const router = Router();

  router.post("/automations/:slug", async (req, res, next) => {
    try {
      const slug = req.params.slug as string;
      const automation = await getAutomationByWebhookSlug(pool, slug);
      if (!automation || automation.trigger_type !== "webhook") {
        throw AppError.notFound("Unknown webhook");
      }
      if (!automation.enabled) {
        throw AppError.notFound("Unknown webhook");
      }

      const signature = getSignatureHeader(req);
      if (!signature) {
        throw AppError.unauthorized("Missing X-MD-AI-Signature header");
      }

      const credentialRow = await getBackgroundCredential(pool, "automation_webhook", automation.id);
      if (!credentialRow) {
        // No signing secret on record — this automation can never be
        // validly called (a config bug, not a caller error), refused the
        // same way as a bad signature rather than a distinct 500.
        throw AppError.unauthorized("Invalid signature");
      }
      const secret = decryptCredential(toEncryptedCredential(credentialRow));
      const rawBody = req.rawBody ?? Buffer.alloc(0);
      if (!verifyWebhookSignature(secret, rawBody, signature)) {
        throw AppError.unauthorized("Invalid signature");
      }

      // Fast ack — the automation's own action (which may be a full
      // Master delegation tree) runs asynchronously; the caller doesn't
      // block on it, same as most webhook-consumer conventions.
      await automationEngine.trigger(automation.id, "webhook");
      res.status(202).json({ data: { accepted: true } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
