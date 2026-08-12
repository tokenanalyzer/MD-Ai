import { Router } from "express";
import type pg from "pg";
import type { MemoryEngine } from "@mdai/shared-types";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { createMemoryBodySchema, patchMemoryBodySchema, searchMemoryBodySchema } from "../schemas.js";
import { getMemory, listPendingMemory, listRejectedMemory } from "../../db/repositories/memoryRepo.js";

export function memoryRouter(pool: pg.Pool, memoryEngine: MemoryEngine): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (req, res, next) => {
    try {
      const category = typeof req.query["category"] === "string" ? (req.query["category"] as never) : undefined;
      const q = typeof req.query["q"] === "string" ? req.query["q"] : "";
      const items = await memoryEngine.search({ query: q, category, topK: 50 });
      res.json({ data: items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/pending", async (_req, res, next) => {
    try {
      const rows = await listPendingMemory(pool);
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  });

  // M6 Memory Center's "rejected" tab.
  router.get("/rejected", async (_req, res, next) => {
    try {
      const rows = await listRejectedMemory(pool);
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post("/search", async (req, res, next) => {
    try {
      const body = searchMemoryBodySchema.parse(req.body);
      const items = await memoryEngine.search(body);
      res.json({ data: items });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = createMemoryBodySchema.parse(req.body);
      const item = await memoryEngine.write({ ...body, source: "user", approvalStatus: "approved" });
      res.status(201).json({ data: item });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const body = patchMemoryBodySchema.parse(req.body);
      const existing = await getMemory(pool, req.params.id as string);
      if (!existing) throw AppError.notFound("Memory item not found");
      const updated = await memoryEngine.update(req.params.id as string, body);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      await memoryEngine.forget(req.params.id as string);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/approve", async (req, res, next) => {
    try {
      const item = await memoryEngine.approve(req.params.id as string);
      res.json({ data: item });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/reject", async (req, res, next) => {
    try {
      const item = await memoryEngine.reject(req.params.id as string);
      res.json({ data: item });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
