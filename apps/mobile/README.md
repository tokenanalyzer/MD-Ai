# apps/mobile

React Native + Expo Android app (M1, per `docs/architecture/09-roadmap.md`).

## Implemented in M1

- `app/(auth)/pairing.tsx` — device pairing against the backend's single-use
  pairing code.
- `app/(vault)/index.tsx` — Provider Vault: add/test/remove a provider API
  key, set a default, connection status. Keys are written straight to
  `expo-secure-store` (Android Keystore-backed, `src/security/secureVault.ts`)
  and only ever leave the device inside a single request body — never
  persisted to the backend. See `docs/architecture/07-security-model.md` §3.
- `app/(chat)/index.tsx` — the primary chat surface: streamed responses over
  the `/ws/tasks/:id` WebSocket, message history, working/error connection
  states, retry action.
- `src/theme/tokens.ts` — the NVIDIA-inspired dark theme (graphite/black
  base, restrained green accent, cyan secondary) used across all screens.

Not yet built (see `docs/architecture/09-roadmap.md` for when): the 2D/3D
Command Center, memory browser, agent/bot status screens, image/file
attachments in chat, biometric app-lock.

## Running it

This code has **not been installed or run in the development sandbox this
was written in** — that environment has no Android SDK/emulator and no
outbound network access to the Expo/npm package hosts needed to install
`expo`/`react-native`. It has been written carefully against the documented
Expo Router / Zustand / expo-secure-store APIs and against the backend
contracts in `docs/architecture/03-api-contracts.md`, which the backend's
own test suite verifies for real (`services/backend/test/`). Before relying
on it:

```sh
pnpm install
cd apps/mobile
npx expo start   # then open in Expo Go or a dev build on an Android device/emulator
```

Set the backend URL in `app.json`'s `expo.extra.mdaiBackendUrl` (defaults to
`http://10.0.2.2:8080`, the Android emulator's alias for the host machine)
or override it at runtime via `src/api/backendUrl.ts`'s `setBackendUrl()`
once a Settings field is wired to it.

## Layout

- `app/` — file-based routes (expo-router): `(auth)`, `(chat)`, `(vault)`.
- `src/api/` — REST client (`client.ts`) with a single-retry-on-401 refresh
  wrapper, plus `backendUrl.ts` for the user-configurable backend URL.
- `src/realtime/chatSocket.ts` — the WS client for streamed chat.
- `src/security/secureVault.ts` — the Keystore-backed provider-key vault.
- `src/state/` — Zustand stores: `sessionStore` (device session tokens,
  also Keystore-backed), `chatStore`, `vaultStore`.
- `src/components/` — shared UI: `MessageBubble`, `StatusDot`, `PrimaryButton`.
