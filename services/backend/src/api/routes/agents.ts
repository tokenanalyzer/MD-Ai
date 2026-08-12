import { Router } from "express";
import type pg from "pg";
import type { AgentRegistry } from "@mdai/shared-types";
import { authGuard } from "../middleware/authGuard.js";
import { patchAgentBodySchema } from "../schemas.js";

export function agentsRouter(pool: pg.Pool, agentRegistry: AgentRegistry): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res, next) => {
    try {
      const cards = await agentRegistry.list();
      res.json({ data: cards });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const body = patchAgentBodySchema.parse(req.body);
      await agentRegistry.setEnabled(req.params.id as string, body.enabled);
      const cards = await agentRegistry.list();
      const card = cards.find((c) => c.id === req.params.id);
      res.json({ data: card });
    } catch (err) {
      next(err);
    }
  });

  // M6: Agent Detail's "allowed delegation relationships" — real
  // `agent_delegation_edges` data (docs/architecture/02-database-schema.md),
  // not a hardcoded UI list. Reuses the same registry method Master's
  // runtime context already calls internally.
  router.get("/:id/delegations", async (req, res, next) => {
    try {
      const options = await agentRegistry.getDelegationOptions(req.params.id as string);
      res.json({ data: options });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
