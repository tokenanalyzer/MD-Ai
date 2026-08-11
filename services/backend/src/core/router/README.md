# core/router

Model Registry (reads/writes `model_registry`, cached with short TTL) and
Model Router (`selectModel` ranking + fallback chain + circuit breaker).
See `docs/architecture/06-provider-model-interfaces.md` for the selection
algorithm this module implements.
