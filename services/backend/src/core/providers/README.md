# core/providers

Implements `ModelProvider` (`@mdai/shared-types`) once per vendor. No code
outside this directory (and `core/router`) may import a vendor SDK
directly — see `docs/architecture/06-provider-model-interfaces.md`.

Planned adapter directories (created in M1–M2): `nvidia-nemotron/`,
`gemini/`, `groq/`, `sambanova/`, `openrouter/`. Each exports a single
`ModelProvider` implementation and nothing else public.
