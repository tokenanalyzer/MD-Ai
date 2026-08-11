# core/router

- `capabilityMatrix.ts` — task-category → capability requirement mapping (M2.3).
- `scoreModel.ts` — pure, unit-testable scoring of Model Registry candidates (M2.4).
- `modelRouter.ts` — `selectModelFromCandidates` (AUTO scoring / MANUAL pin) and `streamChatWithFallback` (retry, circuit breaker, execution).
- `resolveRoutingDecision.ts` — the DB-backed wrapper: fetches candidates from the Model Registry (`core/registry`) and calls the pure selection function.
- `circuitBreaker.ts` — per-provider circuit breaker used by `modelRouter.ts`.

See `docs/architecture/06-provider-model-interfaces.md` §4 for the full
AUTO/MANUAL routing algorithm this module implements, and §3.2 for the
Capability Matrix.
