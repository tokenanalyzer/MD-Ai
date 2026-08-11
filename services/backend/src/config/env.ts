import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MDAI_JWT_SECRET: z.string().min(16, "MDAI_JWT_SECRET must be at least 16 characters"),
  MDAI_PAIRING_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
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
