import type pg from "pg";
import type { MemoryCategory, MemoryEngine, ModelRegistry } from "@mdai/shared-types";
import { markApplied, type EvolutionProposalRow } from "../../db/repositories/evolutionProposalRepo.js";
import { setModelUserConfig } from "../../db/repositories/modelRegistryRepo.js";
import { NoEvolutionApplierError } from "./errors.js";

export interface ApplyProposalDeps {
  pool: pg.Pool;
  modelRegistry: ModelRegistry;
  memoryEngine: MemoryEngine;
}

/**
 * The only place a proposal's diff is ever actually written to live
 * state. Three change classes have a real applier, each reusing an
 * existing subsystem rather than inventing a parallel write path:
 * `model_registry_update` -> Model Registry (`modelRegistry.upsert`, same
 * path `core/registry/discovery.ts` already uses for manual discovery),
 * `routing_policy_update` -> the same `setModelUserConfig` the M2.5
 * mobile picker uses, `knowledge_update` -> Memory
 * (`memoryEngine.write`). `skill_update`/`application_code_update` always
 * throw `NoEvolutionApplierError` (see that class's doc comment) —
 * calling this function is never how either of those gets deployed.
 */
export async function applyEvolutionProposal(deps: ApplyProposalDeps, proposal: EvolutionProposalRow): Promise<EvolutionProposalRow> {
  const resultMetadata = await applyByClass(deps, proposal);
  const updated = await markApplied(deps.pool, proposal.id, resultMetadata);
  if (!updated) throw new Error(`Evolution proposal ${proposal.id} could not be marked applied (unexpected status "${proposal.status}")`);
  return updated;
}

async function applyByClass(deps: ApplyProposalDeps, proposal: EvolutionProposalRow): Promise<Record<string, unknown>> {
  const diff = proposal.diff;
  switch (proposal.change_class) {
    case "model_registry_update": {
      const capabilities = (diff["capabilities"] as Record<string, unknown>) ?? {};
      const id = diff["id"] as string;
      await deps.modelRegistry.upsert({
        id,
        providerId: diff["providerId"] as string,
        providerModelRef: diff["providerModelRef"] as string,
        displayName: diff["displayName"] as string,
        capabilities: {
          contextLength: Number(capabilities["contextLength"] ?? 0),
          supportsTools: Boolean(capabilities["supportsTools"]),
          supportsVision: Boolean(capabilities["supportsVision"]),
          supportsReasoning: Boolean(capabilities["supportsReasoning"]),
          supportsStreaming: Boolean(capabilities["supportsStreaming"]),
          supportsStructuredOutput: Boolean(capabilities["supportsStructuredOutput"]),
          modality: capabilities["modality"] === "multimodal" ? "multimodal" : "text",
          tags: Array.isArray(capabilities["tags"]) ? (capabilities["tags"] as string[]) : [],
        },
        // Ignored by the underlying upsert for an existing row, and
        // overridden by real defaults for a new one — see
        // `modelRegistryRepo.upsertDiscoveredModel`'s SQL.
        availability: "available",
        userEnabled: true,
        userPriority: 0,
        discoveredBy: "evolution_engine",
      });
      return { modelId: id };
    }
    case "routing_policy_update": {
      const modelId = diff["modelId"] as string;
      const newPriority = diff["newPriority"] as number;
      const updated = await setModelUserConfig(deps.pool, modelId, { userPriority: newPriority });
      if (!updated) throw new Error(`routing_policy_update applier: model "${modelId}" not found`);
      return { modelId, newPriority };
    }
    case "knowledge_update": {
      const item = await deps.memoryEngine.write({
        category: diff["category"] as MemoryCategory,
        content: diff["content"] as string,
        tags: Array.isArray(diff["tags"]) ? (diff["tags"] as string[]) : undefined,
        pinned: typeof diff["pinned"] === "boolean" ? (diff["pinned"] as boolean) : undefined,
        importance: typeof diff["importance"] === "number" ? (diff["importance"] as number) : undefined,
        confidence: typeof diff["confidence"] === "number" ? (diff["confidence"] as number) : undefined,
        source: typeof diff["source"] === "string" ? (diff["source"] as string) : "evolution_engine",
        approvalStatus: "approved",
      });
      return { memoryId: item.id };
    }
    case "skill_update":
    case "application_code_update":
      throw new NoEvolutionApplierError(proposal.change_class);
  }
}
