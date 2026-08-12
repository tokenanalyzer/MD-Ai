# Android Setup & Verification

## 1. M2.0 verification status — read this first

**The mobile app has not been run on a physical Android device or emulator
by the agent that wrote this code.** The development environment used to
build MD AI has no Android SDK, no `adb`, no emulator, and no
`ANDROID_HOME`/`ANDROID_SDK_ROOT` configured (checked directly: all three
absent). This is a hard environment constraint, not a shortcut — per
explicit instruction, this is documented rather than claimed as verified.

### What is verified (backend-side + mobile-code-level, real)
- Every REST/WS contract the mobile app calls is exercised by the
  backend's automated test suite (`services/backend/test/`) against a
  real Postgres + Redis, including the exact request/response shapes the
  mobile `src/api/client.ts` and `src/realtime/chatSocket.ts` send and
  parse.
- The provider-key-never-persisted guarantee is verified server-side with
  a real captured-log assertion and a direct DB query
  (`test/integration/providersVault.test.ts`).
- **`pnpm install && tsc --noEmit` succeeds for the whole mobile
  workspace** (Expo/React Native/expo-router/zustand dependency tree
  installs and every screen/store/component in `apps/mobile` typechecks
  cleanly against React Native's real type definitions) — this was
  re-verified in M2 after adding the M2.5 provider/model UI, and again in
  M3 after adding the `agent_progress` delegation-status wiring
  (`chatSocket.ts`'s `onProgress` handler, `chatStore.ts`'s
  `progressLabel` state, the chat screen's status line). It rules out an
  entire class of "wouldn't even build" failures without needing a device.
- Mobile-side pure logic (the secure vault wrapper — `setProviderKey`/
  `getProviderKey`/`deleteProviderKey`/`buildProviderKeysForRequest` — and
  backend-URL resolution) is covered by 11 passing Vitest unit tests using
  a mocked `expo-secure-store`/`expo-constants`
  (`apps/mobile/test/secureVault.test.ts`,
  `apps/mobile/test/backendUrl.test.ts`) — this verifies the *logic* is
  correct (index bookkeeping, no duplicate entries, correct last-4
  computation, empty-map handling), not that it behaves identically inside
  the real Android Keystore.

### What is NOT verified (requires a real device/emulator — not done here)
1. The Expo app actually installs and launches on Android.
2. Pairing screen reaches a real backend over the network from a phone.
3. `expo-secure-store` actually round-trips a key through the real
   Android Keystore (not just the mocked unit test).
4. A real NVIDIA API key, typed into the Vault screen, survives
   test-connection and is usable for a real chat call.
5. SSE token streaming renders correctly in the actual React Native UI
   (WebSocket behavior on-device can differ from Node's `ws` client used
   in backend tests).
6. The API key is never captured by Android-side logging, crash
   reporting, or any OS-level mechanism (Logcat, ANRs, etc.) — the
   backend-side no-secret-in-logs guarantee is verified; the
   device-side equivalent is not, because there is no device here.
7. Provider-failure UX (error banner, retry button, fallback) rendering
   correctly on-screen.
8. (M2.5) The AUTO/MANUAL routing toggle and per-provider default-model
   picker in the Vault screen actually change which model answers — the
   backend-side routing-mode logic is verified
   (`test/integration/routingModes.test.ts`), the UI wiring that calls it
   is not.
9. (M3.9) The `agent_progress` delegation-status text (e.g. "Research
   Agent working…") actually renders in place of the generic "Master
   Agent is answering…" line while a delegated task is in flight — the
   backend emits real `agent_progress` chunks during a live delegation
   (verified end-to-end over a real WebSocket in
   `test/integration/delegation.test.ts`) and the store/screen wiring
   typechecks, but the on-screen rendering timing/behavior is not
   confirmed on-device.

## 2. How to actually verify this (for the owner, on a real device)

```sh
pnpm install
cd apps/mobile
npx expo start
```

Then either scan the QR code with **Expo Go** on an Android phone, or run
`npx expo run:android` with a connected device/emulator for a full native
build (required once `expo-secure-store`'s native module needs a dev
build rather than Expo Go, which is generally fine for this package).

Point the app at your running backend: set `expo.extra.mdaiBackendUrl` in
`app.json`, or override at runtime once a backend-URL field exists in
Settings (`src/api/backendUrl.ts` already supports `setBackendUrl()`).

Walk the exact M2.0 checklist above in order (1–10 from the milestone
instructions): install → pair → open Vault → add a real NVIDIA key → test
connection → send a real chat message → confirm streaming renders → check
your backend's own logs/DB for the key (see the queries in
`docs/architecture/07-security-model.md` §3 for what "never persisted"
should look like) → force a bad key or airplane-mode the backend and
confirm the app shows a clean error rather than a crash.

## 3. Prerequisites for a real device run

- Android device with USB debugging enabled, or Android Studio's
  emulator (AVD) with Play Store or Google APIs image.
- Same Wi-Fi network as the machine running `expo start`, or a tunnel
  (`npx expo start --tunnel`) if the backend isn't reachable directly —
  see `docs/architecture/08-deployment-architecture.md` §4 for the
  Cloudflare Tunnel / WireGuard options that also apply to reaching a
  real Oracle-hosted backend from outside the LAN.
- Node 20+, pnpm, Expo CLI (installed via `npx`, no global install
  required).
