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

export const partSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
});

export const sendMessageBodySchema = z.object({
  parts: z.array(partSchema).min(1),
  providerKeys: z.record(z.string(), z.string().min(1)).refine((v) => Object.keys(v).length > 0, {
    message: "providerKeys must include at least one provider",
  }),
  preferredProviderId: z.string().optional(),
  preferredModelId: z.string().optional(),
});

export const createConversationBodySchema = z.object({
  title: z.string().max(200).optional(),
});

export const cancelTaskBodySchema = z.object({
  reason: z.string().max(500).optional(),
});
