import { Router } from "express";
import type pg from "pg";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { putBackgroundCredentialBodySchema } from "../schemas.js";
import {
  listBackgroundCredentials,
  revokeBackgroundCredential,
  upsertBackgroundCredential,
} from "../../db/repositories/backgroundCredentialRepo.js";
import { BackgroundKeyVaultNotConfiguredError, encryptCredential, last4 } from "../../core/security/backgroundKeyVault.js";
import { getProvider } from "../../db/repositories/providerRepo.js";
import { SEARCH_PROVIDERS } from "../../core/mcp/tools/searchProviders/index.js";

/**
 * M5.12a: the explicit opt-in flow for the background credential vault
 * (docs/architecture/07-security-model.md §3.4/§12) — this is the ONE set
 * of endpoints in the whole API that accepts a credential and stores a
 * durable (encrypted) copy server-side, and it only ever does so for a
 * provider/search-provider id the owner explicitly named here. There is
 * no "save" side effect on any other route — same guarantee
 * `03-api-contracts.md` §3 states for `provider_configs`.
 */
export function backgroundCredentialsRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res, next) => {
    try {
      const rows = await listBackgroundCredentials(pool);
      // Metadata only — never the ciphertext, never anything decrypted.
      res.json({
        data: rows.map((r) => ({
          credentialKind: r.credential_kind,
          credentialId: r.credential_id,
          keyLast4: r.key_last4 ?? undefined,
          enabledByOwnerAt: r.enabled_by_owner_at.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      const body = putBackgroundCredentialBodySchema.parse(req.body);

      if (body.credentialKind === "llm_provider") {
        const provider = await getProvider(pool, body.credentialId);
        if (!provider) throw AppError.badRequest(`Unknown provider id "${body.credentialId}"`);
      } else if (!SEARCH_PROVIDERS[body.credentialId]) {
        throw AppError.badRequest(`Unknown search provider id "${body.credentialId}"`);
      }

      const encrypted = encryptCredential(body.apiKey);
      const row = await upsertBackgroundCredential(pool, body.credentialKind, body.credentialId, encrypted, last4(body.apiKey));
      res.status(201).json({
        data: {
          credentialKind: row.credential_kind,
          credentialId: row.credential_id,
          keyLast4: row.key_last4 ?? undefined,
          enabledByOwnerAt: row.enabled_by_owner_at.toISOString(),
        },
      });
    } catch (err) {
      if (err instanceof BackgroundKeyVaultNotConfiguredError) {
        next(new AppError(503, "background_vault_not_configured", err.message));
        return;
      }
      next(err);
    }
  });

  router.delete("/:kind/:id", async (req, res, next) => {
    try {
      const kind = req.params.kind as "llm_provider" | "search_provider";
      if (kind !== "llm_provider" && kind !== "search_provider") {
        throw AppError.badRequest("kind must be 'llm_provider' or 'search_provider'");
      }
      await revokeBackgroundCredential(pool, kind, req.params.id as string);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
