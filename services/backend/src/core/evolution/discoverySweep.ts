import type pg from "pg";
import type { MemoryEngine, ModelCapabilities, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import { getProviderAdapter } from "../providers/registry.js";
import { lookupCapabilities } from "../router/capabilityCatalog.js";
import { listBackgroundCredentials, toEncryptedCredential } from "../../db/repositories/backgroundCredentialRepo.js";
import { decryptCredential } from "../security/backgroundKeyVault.js";
import { createProposal } from "../../db/repositories/evolutionProposalRepo.js";
import { writeAuditLog } from "../../db/repositories/auditLogRepo.js";
import { computeRequiresApproval } from "./changeClassPolicy.js";
import { reviewAndMaybeApply } from "./reviewAndApply.js";

export interface DiscoverySweepDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  memoryEngine: MemoryEngine;
}

function capabilitiesEqual(a: ModelCapabilities, b: ModelCapabilities): boolean {
  return (
    a.contextLength === b.contextLength &&
    a.supportsTools === b.supportsTools &&
    a.supportsVision === b.supportsVision &&
    a.supportsReasoning === b.supportsReasoning &&
    a.supportsStreaming === b.supportsStreaming &&
    a.supportsStructuredOutput === b.supportsStructuredOutput &&
    a.modality === b.modality &&
    JSON.stringify([...a.tags].sort()) === JSON.stringify([...b.tags].sort())
  );
}

/**
 * M9 discovery sweep: real `adapter.listModels(apiKey)` calls, using ONLY
 * providers the owner explicitly opted in for background use (M5.12a's
 * `background_credentials`, kind `llm_provider`) — never a request-scoped
 * key, and never fabricated results when a provider call fails (skipped
 * quietly, same "skip quietly, never fabricate" discipline every bot in
 * this codebase already follows). A `model_registry_update` proposal is
 * only created when the live list actually disagrees with the current
 * registry (a genuinely new model, or a capability/name change) — an
 * unchanged, already-known model produces no proposal at all, so a
 * healthy steady state means an empty queue, not noise.
 */
export async function runDiscoverySweep(deps: DiscoverySweepDeps): Promise<{ proposalsCreated: number }> {
  const credentials = await listBackgroundCredentials(deps.pool, "llm_provider");
  let proposalsCreated = 0;

  for (const cred of credentials) {
    const providerId = cred.credential_id;
    const adapter = getProviderAdapter(providerId);
    if (!adapter) continue; // opted-in credential for a provider this process has no adapter for

    let models;
    try {
      const apiKey = decryptCredential(toEncryptedCredential(cred));
      models = await adapter.listModels(apiKey);
    } catch (err) {
      await writeAuditLog(deps.pool, {
        actor: "system",
        action: "evolution.discovery.skipped",
        targetType: "provider",
        targetId: providerId,
        metadata: { reason: err instanceof Error ? err.message : "unknown error" },
      });
      continue;
    }

    for (const model of models) {
      const existing = await deps.modelRegistry.get(model.id);
      const capabilities = lookupCapabilities(model.id);

      if (existing && existing.displayName === model.displayName && capabilitiesEqual(existing.capabilities, capabilities)) {
        continue; // nothing changed — no proposal noise
      }

      const diff = {
        id: model.id,
        providerId: model.providerId,
        providerModelRef: model.providerModelRef,
        displayName: model.displayName,
        capabilities,
        previous: existing ? { displayName: existing.displayName, capabilities: existing.capabilities } : null,
      };

      const proposal = await createProposal(deps.pool, {
        changeClass: "model_registry_update",
        title: existing ? `Update model metadata: ${model.displayName}` : `Discovered new model: ${model.displayName}`,
        rationale: existing
          ? `Provider "${providerId}"'s live model list reports different capabilities/name for "${model.id}" than the registry currently has.`
          : `Provider "${providerId}"'s live model list includes "${model.id}", not yet in the registry.`,
        diff,
        riskLevel: "low",
        requiresApproval: computeRequiresApproval("model_registry_update"),
      });
      proposalsCreated++;

      await deps.eventBus.publish({
        sourceType: "system",
        sourceId: proposal.id,
        payload: {
          type: "evolution.proposal.created",
          proposalId: proposal.id,
          changeClass: "model_registry_update",
          riskLevel: "low",
          requiresApproval: proposal.requires_approval,
        },
      });

      await reviewAndMaybeApply(deps, proposal);
    }
  }

  return { proposalsCreated };
}
