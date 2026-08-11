import type { ModelCapabilities, ModelRegistryEntry, TaskCategory } from "@mdai/shared-types";

/**
 * Maps a task category to capability requirements (docs/architecture/
 * 06-provider-model-interfaces.md §5). `hardRequirements` exclude a
 * candidate outright — a task tagged `vision` will never route to a
 * text-only model, full stop. `reasoningPreferred`/`minContextLength`
 * influence scoring (`scoreModel.ts`) without excluding anything, since
 * "reasoning" and "long-context" are about picking a *better* fit, not a
 * hard capability boundary the way tool-calling or vision are.
 *
 * This is the only place task→capability mapping is decided. The router
 * never infers a category from a model's name or a prompt's contents —
 * the caller (Master Agent, or eventually a specialist agent) states the
 * category explicitly via `RoutingCriteria.taskCategory`.
 */
export interface CapabilityRequirement {
  hardRequirements: (keyof ModelCapabilities)[];
  minContextLength?: number;
  reasoningPreferred?: boolean;
  latencyWeighted?: boolean;
}

export const TASK_CATEGORY_REQUIREMENTS: Record<TaskCategory, CapabilityRequirement> = {
  chat: { hardRequirements: [] },
  reasoning: { hardRequirements: [], reasoningPreferred: true },
  research: { hardRequirements: [], reasoningPreferred: true, minContextLength: 32_000 },
  "long-context": { hardRequirements: [], minContextLength: 100_000 },
  vision: { hardRequirements: ["supportsVision"] },
  "tool-calling": { hardRequirements: ["supportsTools"] },
  "structured-output": { hardRequirements: ["supportsStructuredOutput"] },
  fast: { hardRequirements: [], latencyWeighted: true },
};

export interface CapabilityCheckResult {
  capable: boolean;
  reason?: string;
}

/** Hard-filter only — does this model even qualify for the category. Scoring/preference is separate (scoreModel.ts). */
export function isCapable(entry: ModelRegistryEntry, category: TaskCategory | undefined): CapabilityCheckResult {
  if (!category) return { capable: true };
  const requirement = TASK_CATEGORY_REQUIREMENTS[category];

  for (const cap of requirement.hardRequirements) {
    if (!entry.capabilities[cap]) {
      return { capable: false, reason: `missing required capability: ${String(cap)}` };
    }
  }
  if (requirement.minContextLength && entry.capabilities.contextLength < requirement.minContextLength) {
    return {
      capable: false,
      reason: `context length ${entry.capabilities.contextLength} below required ${requirement.minContextLength}`,
    };
  }
  return { capable: true };
}
