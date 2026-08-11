import { Router } from "express";
import type pg from "pg";
import type { ModelRegistry } from "@mdai/shared-types";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { patchProviderConfigBodySchema, setDefaultModelBodySchema, testConnectionBodySchema } from "../schemas.js";
import { getProviderAdapter, KNOWN_PROVIDER_IDS } from "../../core/providers/registry.js";
import { discoverModels } from "../../core/registry/discovery.js";
import {
  deleteProviderConfig,
  getProvider,
  getProviderConfigById,
  getProviderDefaultModel,
  listProviderConfigs,
  listProviders,
  setDefaultProviderConfig,
  setProviderDefaultModel,
  upsertProviderConfigStatus,
  type ProviderConfigRow,
} from "../../db/repositories/providerRepo.js";

async function toProviderConfigDto(pool: pg.Pool, row: ProviderConfigRow) {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    keyLast4: row.key_last4,
    status: row.status,
    lastTestAt: row.last_test_at?.toISOString(),
    lastTestError: row.last_test_error,
    isDefault: row.is_default,
    defaultModelId: await getProviderDefaultModel(pool, row.id),
  };
}

export function providersRouter(pool: pg.Pool, modelRegistry: ModelRegistry): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res, next) => {
    try {
      const providers = await listProviders(pool);
      res.json({
        data: providers.map((p) => ({
          id: p.id,
          displayName: p.display_name,
          baseUrl: p.base_url,
          docsUrl: p.docs_url,
          builtin: p.enabled_builtin,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/configs", async (req, res, next) => {
    try {
      const provider = await getProvider(pool, req.params.id as string);
      if (!provider) throw AppError.notFound(`Unknown provider: ${req.params.id}`);
      const configs = await listProviderConfigs(pool, req.params.id);
      res.json({ data: await Promise.all(configs.map((c) => toProviderConfigDto(pool, c))) });
    } catch (err) {
      next(err);
    }
  });

  // The only endpoint that ever sees a provider key. It uses the key for
  // exactly one outbound call, stores no secret afterward — see
  // docs/architecture/07-security-model.md §3.
  router.post("/:id/test-connection", async (req, res, next) => {
    const providerId = req.params.id as string;
    try {
      if (!KNOWN_PROVIDER_IDS.includes(providerId)) throw AppError.notFound(`Unknown provider: ${providerId}`);
      const body = testConnectionBodySchema.parse(req.body);
      const adapter = getProviderAdapter(providerId);
      if (!adapter) throw AppError.notFound(`No adapter registered for provider: ${providerId}`);

      const result = await adapter.testConnection(body.apiKey);
      const keyLast4 = body.apiKey.length >= 4 ? body.apiKey.slice(-4) : undefined;
      const config = await upsertProviderConfigStatus(pool, {
        providerId,
        label: body.label,
        status: result.ok ? "connected" : "error",
        keyLast4,
        lastTestError: result.ok ? undefined : result.error,
      });

      // M2.1: a successful test is also a discovery opportunity — the
      // caller just proved they hold a working key, and the adapter
      // already fetched the model list to run the test.
      if (result.ok && result.discoveredModels && result.discoveredModels.length > 0) {
        await discoverModels(modelRegistry, providerId, result.discoveredModels);
      }

      res.json({
        data: {
          result: { ok: result.ok, latencyMs: result.latencyMs, error: result.error },
          config: await toProviderConfigDto(pool, config),
          discoveredModelCount: result.discoveredModels?.length ?? 0,
        },
      });
    } catch (err) {
      next(err);
    }
    // `body.apiKey` (and `body` itself) fall out of scope here — nothing
    // above assigns it to a variable outside this handler.
  });

  router.patch("/:id/configs/:configId", async (req, res, next) => {
    try {
      const body = patchProviderConfigBodySchema.parse(req.body);
      const existing = await getProviderConfigById(pool, req.params.configId as string);
      if (!existing) throw AppError.notFound("Provider config not found");
      if (body.isDefault) await setDefaultProviderConfig(pool, existing.id);
      const updated = await getProviderConfigById(pool, existing.id);
      res.json({ data: await toProviderConfigDto(pool, updated!) });
    } catch (err) {
      next(err);
    }
  });

  // M2.5: per-provider default model picker.
  router.put("/:id/configs/:configId/default-model", async (req, res, next) => {
    try {
      const body = setDefaultModelBodySchema.parse(req.body);
      const existing = await getProviderConfigById(pool, req.params.configId as string);
      if (!existing) throw AppError.notFound("Provider config not found");
      const model = await modelRegistry.get(body.modelId);
      if (!model || model.providerId !== existing.provider_id) {
        throw AppError.badRequest(`${body.modelId} is not a known model for provider ${existing.provider_id}`);
      }
      await setProviderDefaultModel(pool, existing.id, body.modelId);
      res.json({ data: await toProviderConfigDto(pool, existing) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id/configs/:configId", async (req, res, next) => {
    try {
      await deleteProviderConfig(pool, req.params.configId as string);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
