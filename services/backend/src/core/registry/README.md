# core/registry

Model Registry (M2.1): `modelRegistryService.ts` implements the
`ModelRegistry` interface (`@mdai/shared-types`) over the `model_registry`
table with a short in-process cache. `discovery.ts` merges a provider's
`listModels()` result with the hand-curated capability catalog
(`core/router/capabilityCatalog.ts`) and upserts each into the registry —
triggered from a successful `POST /providers/:id/test-connection`, not on
an autonomous schedule (that's the Evolution Engine, M9). See
`docs/architecture/06-provider-model-interfaces.md` §3.
