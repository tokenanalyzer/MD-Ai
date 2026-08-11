import { z } from "zod";

export const pairBodySchema = z.object({
  pairingCode: z.string().min(1),
  deviceName: z.string().min(1).max(200),
  platform: z.enum(["android", "pc", "other"]),
  pushToken: z.string().optional(),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export const revokeBodySchema = z.object({
  deviceSessionId: z.string().uuid(),
});

export const testConnectionBodySchema = z.object({
  apiKey: z.string().min(1),
  label: z.string().min(1).max(100).default("default"),
});

export const patchProviderConfigBodySchema = z.object({
  isDefault: z.boolean().optional(),
});

export const setDefaultModelBodySchema = z.object({
  modelId: z.string().min(1),
});

export const patchModelBodySchema = z.object({
  // Model registry ids contain "/" (e.g. "groq/llama-3.3-70b-versatile"),
  // which doesn't survive as an Express route param cleanly — passed in
  // the body instead of the URL for this one route.
  modelId: z.string().min(1),
  userEnabled: z.boolean().optional(),
  userPriority: z.number().int().min(-100).max(100).optional(),
});

export const partSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
});

export const taskCategorySchema = z.enum([
  "chat",
  "reasoning",
  "research",
  "long-context",
  "vision",
  "tool-calling",
  "structured-output",
  "fast",
]);

export const sendMessageBodySchema = z.object({
  parts: z.array(partSchema).min(1),
  providerKeys: z.record(z.string(), z.string().min(1)).refine((v) => Object.keys(v).length > 0, {
    message: "providerKeys must include at least one provider",
  }),
  preferredProviderId: z.string().optional(),
  preferredModelId: z.string().optional(),
  taskCategory: taskCategorySchema.optional(),
  /** "manual" requires preferredProviderId (and normally preferredModelId) — see routes/conversations.ts. */
  routingMode: z.enum(["auto", "manual"]).optional(),
});

export const createConversationBodySchema = z.object({
  title: z.string().max(200).optional(),
});

export const cancelTaskBodySchema = z.object({
  reason: z.string().max(500).optional(),
});
