# apps/mobile

React Native + Expo Android app. Scaffolded in M1 via `npx create-expo-app`
using `expo-router`; this directory currently holds only the planned
structure documented in `docs/architecture/01-repository-structure.md` §1.

Planned top-level route groups (`app/`): `(auth)`, `(chat)`,
`(command-center)`, `(vault)`, `(memory)`, `(agents)`, `(settings)`.

Planned feature modules (`src/features/`): `chat`, `command-center`,
`provider-vault`, `agents`, `bots`, `memory`.

Provider API keys are entered here but the authoritative encrypted copy
lives server-side — see `docs/architecture/07-security-model.md` §3 for
why, and what Android Keystore (`src/security/`) is actually used for
(device session + local unlock, not the source-of-truth key store).
