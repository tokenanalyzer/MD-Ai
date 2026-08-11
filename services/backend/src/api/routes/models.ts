import { Router } from "express";
import type pg from "pg";
import type { ModelRegistry } from "@mdai/shared-types";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { patchModelBodySchema } from "../schemas.js";
import { setModelUserConfig } from "../../db/repositories/modelRegistryRepo.js";

export function modelsRouter(pool: pg.Pool, modelRegistry: ModelRegistry): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (req, res, next) => {
    try {
      const providerId = typeof req.query["providerId"] === "string" ? req.query["providerId"] : undefined;
      const enabledOnly = req.query["enabledOnly"] === "true";
      const models = await modelRegistry.list({ providerId, enabledOnly });
      res.json({ data: models });
    } catch (err) {
      next(err);
    }
  });

  // modelId travels in the body, not the URL — registry ids contain "/"
  // (e.g. "groq/llama-3.3-70b-versatile"), see schemas.ts.
  router.patch("/", async (req, res, next) => {
    try {
      const body = patchModelBodySchema.parse(req.body);
      const existing = await modelRegistry.get(body.modelId);
      if (!existing) throw AppError.notFound(`Unknown model: ${body.modelId}`);
      await setModelUserConfig(pool, body.modelId, body);
      const updated = await modelRegistry.get(body.modelId);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
