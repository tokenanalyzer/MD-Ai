import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MDAI_JWT_SECRET: z.string().min(16, "MDAI_JWT_SECRET must be at least 16 characters"),
  MDAI_PAIRING_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  // M5.12a: key-encrypting key for the opt-in background credential vault
  // (core/security/backgroundKeyVault.ts) — base64-encoded, exactly 32
  // bytes decoded. Optional at the env-schema level (most deployments never
  // opt any provider into background use), but every actual encrypt/decrypt
  // call requires it and fails with a clear, specific error if absent —
  // see docs/architecture/07-security-model.md §3.4/§12.
  MDAI_BACKGROUND_KEY_KEK: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses process.env once, validated. Throws with a clear message on misconfiguration rather than failing later with a cryptic error. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: clears the cached env so a test can reload with different values. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
