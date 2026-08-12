process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://mdai:mdai@localhost:5432/mdai_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";
process.env.MDAI_JWT_SECRET ??= "test-only-secret-do-not-use-in-prod-32chars";
process.env.MDAI_PAIRING_CODE_TTL_MINUTES ??= "10";
// M5.12a: a fixed 32-byte test KEK so background-credential-vault tests
// don't each need to generate/reset their own — never used outside tests.
process.env.MDAI_BACKGROUND_KEY_KEK ??= "dGVzdC1vbmx5LWtlay1kby1ub3QtdXNlLWluLXByb2Q="; // base64("test-only-kek-do-not-use-in-prod") — 32 bytes decoded
