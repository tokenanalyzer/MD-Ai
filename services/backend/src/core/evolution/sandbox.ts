import type pg from "pg";
import type { MemoryCategory } from "@mdai/shared-types";
import type { EvolutionProposalRow } from "../../db/repositories/evolutionProposalRepo.js";
import { getModelRegistryEntry, setModelUserConfig, upsertDiscoveredModel, type UpsertModelInput } from "../../db/repositories/modelRegistryRepo.js";
import { insertMemory } from "../../db/repositories/memoryRepo.js";

export interface SandboxResult {
  validated: boolean;
  checks: string[];
  reason?: string;
}

const VALID_MEMORY_CATEGORIES: MemoryCategory[] = [
  "personal_context",
  "projects",
  "goals",
  "preferences",
  "decisions",
  "research",
  "knowledge",
  "conversations",
  "agent_lessons",
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Real sandbox testing (docs/architecture/07-security-model.md §5): every
 * check here runs inside a genuine Postgres transaction, calling the SAME
 * repo functions `applyProposal.ts` uses for the real apply, then ALWAYS
 * rolls back — nothing here ever commits. This is an honest, scoped
 * interpretation of "isolated environment" appropriate to a single-user
 * personal system running one Postgres instance, not the fully separate
 * container/DB the doc's language evokes for a larger deployment — noted
 * explicitly here rather than silently treated as equivalent, per this
 * project's no-fake-functionality rule.
 *
 * `skill_update`/`application_code_update` have no validator: neither has
 * an automatic applier either (see `applyProposal.ts`), so there is
 * nothing here to safely rehearse in isolation yet — both go straight to
 * human review once a proposal of that class exists.
 */
export async function sandboxTestProposal(pool: pg.Pool, proposal: EvolutionProposalRow): Promise<SandboxResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    switch (proposal.change_class) {
      case "model_registry_update":
        return await sandboxModelRegistryUpdate(client, proposal.diff);
      case "routing_policy_update":
        return await sandboxRoutingPolicyUpdate(client, proposal.diff);
      case "knowledge_update":
        return await sandboxKnowledgeUpdate(client, proposal.diff);
      case "skill_update":
      case "application_code_update":
        return {
          validated: false,
          checks: [],
          reason: `no sandbox validator implemented for change class "${proposal.change_class}" — always requires manual/human review`,
        };
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function sandboxModelRegistryUpdate(client: pg.PoolClient, diff: Record<string, unknown>): Promise<SandboxResult> {
  const checks: string[] = [];
  if (!isNonEmptyString(diff["id"])) return { validated: false, checks, reason: "diff.id missing" };
  checks.push("id present");
  if (!isNonEmptyString(diff["providerId"])) return { validated: false, checks, reason: "diff.providerId missing" };
  checks.push("providerId present");
  if (!isNonEmptyString(diff["providerModelRef"])) return { validated: false, checks, reason: "diff.providerModelRef missing" };
  checks.push("providerModelRef present");
  if (!isNonEmptyString(diff["displayName"])) return { validated: false, checks, reason: "diff.displayName missing" };
  checks.push("displayName present");
  const capabilities = diff["capabilities"];
  if (!capabilities || typeof capabilities !== "object") return { validated: false, checks, reason: "diff.capabilities missing" };
  checks.push("capabilities present");
  const caps = capabilities as Record<string, unknown>;

  const input: UpsertModelInput = {
    id: diff["id"] as string,
    providerId: diff["providerId"] as string,
    providerModelRef: diff["providerModelRef"] as string,
    displayName: diff["displayName"] as string,
    contextLength: Number(caps["contextLength"] ?? 0),
    supportsTools: Boolean(caps["supportsTools"]),
    supportsVision: Boolean(caps["supportsVision"]),
    supportsReasoning: Boolean(caps["supportsReasoning"]),
    supportsStreaming: Boolean(caps["supportsStreaming"]),
    supportsStructuredOutput: Boolean(caps["supportsStructuredOutput"]),
    modality: caps["modality"] === "multimodal" ? "multimodal" : "text",
    tags: Array.isArray(caps["tags"]) ? (caps["tags"] as string[]) : [],
    discoveredBy: "evolution_engine",
  };

  await upsertDiscoveredModel(client, input);
  checks.push("upsert executed in an isolated transaction without a constraint violation");
  return { validated: true, checks };
}

async function sandboxRoutingPolicyUpdate(client: pg.PoolClient, diff: Record<string, unknown>): Promise<SandboxResult> {
  const checks: string[] = [];
  const modelId = diff["modelId"];
  if (!isNonEmptyString(modelId)) return { validated: false, checks, reason: "diff.modelId missing" };
  checks.push("modelId present");

  const existing = await getModelRegistryEntry(client, modelId);
  if (!existing) return { validated: false, checks, reason: `model "${modelId}" does not exist in the registry` };
  checks.push("target model exists");

  const newPriority = diff["newPriority"];
  if (typeof newPriority !== "number" || !Number.isInteger(newPriority) || newPriority < 0 || newPriority > 10) {
    return { validated: false, checks, reason: `newPriority ${JSON.stringify(newPriority)} out of bounds [0,10]` };
  }
  checks.push("newPriority within bounds");

  await setModelUserConfig(client, modelId, { userPriority: newPriority });
  checks.push("update executed in an isolated transaction without a constraint violation");
  return { validated: true, checks };
}

async function sandboxKnowledgeUpdate(client: pg.PoolClient, diff: Record<string, unknown>): Promise<SandboxResult> {
  const checks: string[] = [];
  if (!isNonEmptyString(diff["content"])) return { validated: false, checks, reason: "diff.content missing" };
  checks.push("content present");

  const category = diff["category"];
  if (!isNonEmptyString(category) || !VALID_MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
    return { validated: false, checks, reason: `diff.category ${JSON.stringify(category)} is not a valid memory category` };
  }
  checks.push("category valid");

  await insertMemory(client, {
    category: category as MemoryCategory,
    content: diff["content"] as string,
    source: isNonEmptyString(diff["source"]) ? (diff["source"] as string) : "evolution_engine",
  });
  checks.push("insert executed in an isolated transaction without a constraint violation");
  return { validated: true, checks };
}
