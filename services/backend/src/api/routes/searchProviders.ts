import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { SEARCH_PROVIDERS } from "../../core/mcp/tools/searchProviders/index.js";

const testSearchProviderConnectionBodySchema = z.object({
  apiKey: z.string().min(1),
});

const TEST_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Search-provider (Brave/Tavily) keys are request-scoped `toolKeys` (see
 * schemas.ts `toolKeys` on the message-send body) — unlike LLM provider
 * keys, there is no persisted config row for them, so this router is
 * intentionally thinner than providers.ts: list the available providers,
 * and let the client verify a key works before storing it locally
 * (Android Keystore, apps/mobile/src/security/secureVault.ts) — nothing
 * server-side to keep in sync.
 */
export function searchProvidersRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res) => {
    res.json({
      data: Object.values(SEARCH_PROVIDERS).map((p) => ({ id: p.id, displayName: p.displayName })),
    });
  });

  // The only endpoint that ever sees a search-provider key. It uses the
  // key for one real (trivial) search call and stores no secret
  // afterward — same one-shot-use guarantee as providers.ts's
  // test-connection.
  router.post("/:id/test-connection", async (req, res, next) => {
    const providerId = req.params.id as string;
    try {
      const provider = SEARCH_PROVIDERS[providerId];
      if (!provider) throw AppError.notFound(`Unknown search provider: ${providerId}`);
      const body = testSearchProviderConnectionBodySchema.parse(req.body);

      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS);
      try {
        await provider.search(body.apiKey, "test", 1, controller.signal);
        res.json({ data: { ok: true, latencyMs: Date.now() - startedAt } });
      } catch (err) {
        res.json({
          data: { ok: false, latencyMs: Date.now() - startedAt, error: err instanceof Error ? err.message : "Connection failed" },
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      next(err);
    }
    // `body.apiKey` (and `body` itself) fall out of scope here — nothing
    // above assigns it to a variable outside this handler.
  });

  return router;
}
