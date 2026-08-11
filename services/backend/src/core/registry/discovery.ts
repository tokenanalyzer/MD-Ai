import type { ModelInfo, ModelRegistry } from "@mdai/shared-types";
import { lookupCapabilities } from "../router/capabilityCatalog.js";

/**
 * Merges a provider's raw `listModels()` result (id + display name only)
 * with the hand-curated capability catalog, and upserts each into the
 * Model Registry. Triggered from the Vault's test-connection flow
 * (`api/routes/providers.ts`) — i.e. discovery happens when the owner
 * proves they hold a working key for a provider, not on an unauthenticated
 * schedule. Full autonomous discovery sweeps are the Evolution Engine's
 * job (M9); this is the M2 "don't hard-code the registry to today's
 * models" mechanism — models the catalog doesn't recognize yet still get
 * registered, just with conservative/unverified capabilities until
 * someone curates them (docs/architecture/06-provider-model-interfaces.md §3).
 */
export async function discoverModels(registry: ModelRegistry, providerId: string, models: ModelInfo[]): Promise<void> {
  for (const model of models) {
    const capabilities = lookupCapabilities(model.id);
    await registry.upsert({
      id: model.id,
      providerId,
      providerModelRef: model.providerModelRef,
      displayName: model.displayName,
      capabilities,
      availability: "available",
      lastVerifiedAt: new Date().toISOString(),
      userEnabled: true,
      userPriority: 0,
      discoveredBy: "manual",
    });
  }
}
