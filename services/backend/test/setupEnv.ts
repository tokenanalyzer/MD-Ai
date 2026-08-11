process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://mdai:mdai@localhost:5432/mdai_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";
process.env.MDAI_JWT_SECRET ??= "test-only-secret-do-not-use-in-prod-32chars";
process.env.MDAI_PAIRING_CODE_TTL_MINUTES ??= "10";
