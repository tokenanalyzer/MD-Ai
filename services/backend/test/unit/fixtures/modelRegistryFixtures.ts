import type { ModelRegistryEntry } from "@mdai/shared-types";

/** Builds a fake ModelRegistryEntry for router/capability/scoring unit tests — no DB involved. */
export function fakeModelEntry(id: string, overrides: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry {
  const providerId = id.split("/")[0] as string;
  return {
    id,
    providerId,
    providerModelRef: id.slice(providerId.length + 1),
    displayName: id,
    capabilities: {
      contextLength: 32_000,
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsStructuredOutput: false,
      modality: "text",
      tags: [],
    },
    availability: "available",
    userEnabled: true,
    userPriority: 0,
    discoveredBy: "manual",
    ...overrides,
  };
}
