import { Router } from "express";
import type pg from "pg";
import type { ToolRegistry } from "@mdai/shared-types";
import { authGuard } from "../middleware/authGuard.js";

/** Read-only discovery — tool health/enablement is managed by the Tool Registry itself, not by hand-editing through this API in M4. */
export function toolsRouter(pool: pg.Pool, toolRegistry: ToolRegistry): Router {
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

  return router;
}
