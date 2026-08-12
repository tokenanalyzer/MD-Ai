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
10. (M4.14) The same status line rendering Research's tool-specific
    labels — "Searching the web…", "Reading N source(s)…" — during a
    real tool-assisted research turn. No new mobile code was needed (the
    M3 infrastructure already renders whatever label arrives), and the
    backend genuinely emits these exact labels, verified end-to-end over
    a real WebSocket in `test/integration/researchTools.test.ts`; the
    on-device rendering itself is unconfirmed, same as item 9.

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

## 4. Development Build workflow (real physical device, live development)

Expo Go alone is not enough for MD AI beyond the earliest milestones:
`expo-secure-store` works in Expo Go, but `expo-notifications`'s push
token registration (M5.13) needs a config-plugin-injected native module,
and future milestones (3D Command Center's `@react-three/fiber`,
eventually) will need custom native code Expo Go can't load. This section
sets up an **Expo Development Build** — your own custom "Expo Go" with
MD AI's native modules baked in — without replacing the existing
managed-workflow architecture (`app.json` stays the single config source;
nothing here ejects to a bare RN project on disk permanently — `expo
prebuild`'s `android/` output is regenerable, not hand-maintained).

### 4.1 Expo development build configuration

Already wired into this repo:
- `expo-dev-client` is a dependency (`apps/mobile/package.json`) and
  listed in `app.json`'s `plugins`.
- `eas.json` defines three build profiles: `development`
  (`developmentClient: true`, produces an installable `.apk`),
  `preview` (same, without the dev-client debug menu), `production`.

You do **not** need an EAS/Expo account to use a development build if you
build locally (§4.2 option A). You **do** need one for cloud builds
(§4.2 option B), which is the recommended path if you don't have Android
Studio/the Android SDK installed locally.

### 4.2 Android development configuration

**Option A — local build (requires Android Studio + SDK on your
machine):**
```sh
cd apps/mobile
npx expo prebuild --platform android   # generates android/ (gitignored, regenerable)
npx expo run:android                   # builds + installs the dev client on a connected device
```

**Option B — EAS cloud build (no local Android SDK needed):**
```sh
npm install -g eas-cli        # or use `npx eas-cli` for every command below
cd apps/mobile
eas login                     # free Expo account
eas build:configure           # links this project to an EAS project id (writes to app.json)
eas build --profile development --platform android
```
EAS builds in the cloud and gives you a QR code / download link for the
resulting `.apk` — install it on your phone directly (enable "install
from unknown sources" if prompted, since this isn't a Play Store build).

### 4.3 Development server commands

Once the dev-client `.apk` is installed on your phone (build once, keep
using it — you only rebuild when a *native* dependency changes, not on
every JS change):
```sh
cd apps/mobile
npx expo start --dev-client
```
Scan the QR code from the dev-client app on your phone (not the camera
app, not Expo Go). JS changes hot-reload exactly like Expo Go; native
changes require rebuilding via §4.2.

### 4.4 Physical Android device connection workflow

1. Enable Developer Options + USB debugging on the phone (Settings →
   About Phone → tap "Build number" 7×, then Settings → Developer
   Options → USB debugging).
2. Connect via USB for the first `expo run:android` (option A) — this is
   only needed for the local-build path; EAS builds skip this since the
   `.apk` is sideloaded directly.
3. For the day-to-day dev server (`expo start --dev-client`), the phone
   just needs the dev-client app installed and network reachability to
   your dev machine (§4.5) — no cable required after that.

### 4.5 LAN/network configuration

The phone and your dev machine must be able to reach each other:
- **Same Wi-Fi (preferred)**: `expo start --dev-client` prints a LAN URL;
  the QR code encodes it automatically.
- **Different networks / restrictive Wi-Fi isolation**: `npx expo start
  --dev-client --tunnel` routes through Expo's tunnel service (no local
  network requirement, higher latency).
- **Firewall**: Metro's default port (8081) must be reachable from the
  phone if not tunneling.

### 4.6 Backend API URL configuration

Three layers, in priority order (`src/api/backendUrl.ts`):
1. **A SecureStore-persisted override**, set once at runtime via
   `setBackendUrl()` — highest priority, survives across app restarts.
   No UI screen calls this yet; call it from a debug console or add a
   Settings field if you want an in-app switcher.
2. **`EXPO_PUBLIC_MDAI_BACKEND_URL`** (new in this milestone) — Expo/
   Metro inlines `EXPO_PUBLIC_*` env vars at bundle time, so this is the
   fastest way to point a dev build at your own machine without editing
   any file:
   ```sh
   EXPO_PUBLIC_MDAI_BACKEND_URL=http://192.168.1.50:8080 npx expo start --dev-client
   ```
   Replace `192.168.1.50` with your dev machine's actual LAN IP (`ip
   addr` / `ifconfig` / Windows `ipconfig`) — **not** `localhost`, since
   the phone is a separate device on the network.
3. **`app.json`'s `expo.extra.mdaiBackendUrl`** — the committed default,
   currently the Android-emulator-only alias `http://10.0.2.2:8080`
   (unreachable from a physical device; use layer 1 or 2 instead when on
   real hardware).

This is a hostname/port, never a secret — it does not touch the provider
API key vault (`src/security/secureVault.ts`), which remains exactly as
designed in `07-security-model.md` §3: keys live only in the Android
Keystore, never in an env var, never in `app.json`.

### 4.7 WebSocket URL configuration

Derived automatically from the backend URL via `wsUrlFrom()`
(`http`→`ws`, `https`→`wss`) — no separate configuration. Whichever of
the three layers above resolves the backend URL also resolves the WS
gateway URL used by `src/realtime/chatSocket.ts`.

### 4.8 Environment/configuration strategy for development

- **Never commit real secrets.** `EXPO_PUBLIC_MDAI_BACKEND_URL` is a
  non-secret convenience var — put it in a local, gitignored `.env` file
  (Expo/Metro reads `.env` automatically) or export it in your shell,
  never hardcode it in `app.json` for a shared/committed config.
- **Provider API keys are never part of this layer at all** — they're
  entered once in the Vault screen on-device and live only in
  SecureStore, per the existing architecture (unchanged by this
  milestone).
- **Backend-side background credentials** (M5.12a's opt-in vault) are a
  separate, server-side concern (`MDAI_BACKGROUND_KEY_KEK` in the
  backend's own env, not the mobile app's) — see `12-bot-engine.md` §13.

### 4.9 How the phone connects to the local backend

With the backend running locally (`pnpm --filter @mdai/backend dev`, or
`docker compose up` — see `08-deployment-architecture.md` §3) and the
phone on the same Wi-Fi as that machine: set
`EXPO_PUBLIC_MDAI_BACKEND_URL=http://<your-LAN-IP>:8080` (§4.6, layer 2)
before starting the dev server. Confirm reachability first with the
phone's own browser: `http://<your-LAN-IP>:8080/healthz` should return
`200 OK` before bothering to open the app.

### 4.10 How the phone connects to Oracle when local backend is unavailable

Once your Oracle instance is up (`08-deployment-architecture.md`), either:
- Set `EXPO_PUBLIC_MDAI_BACKEND_URL=https://<your-oracle-domain>` before
  starting the dev server, or
- Call `setBackendUrl("https://<your-oracle-domain>")` once at runtime
  (SecureStore layer, §4.6 layer 1) so it persists across app restarts
  without needing the env var set every time.

No code change is required to switch between local and Oracle — both are
just different values for the same backend-URL resolution chain.

### 4.11 SecureStore development behavior

`expo-secure-store` is backed by the Android Keystore on a real device —
this is real, hardware-backed encryption, not a dev-only mock, and it
behaves identically in a development build and a production build. The
one thing that differs from Expo Go: SecureStore data is scoped per app
package (`ai.mdai.app`), so uninstalling/reinstalling the dev-client
`.apk` (not just clearing Metro cache) clears the vault, requiring
re-pairing and re-entering provider keys. Test coverage for the wrapper
logic itself (index bookkeeping, last-4 computation) runs against a
mocked SecureStore in CI (`apps/mobile/test/secureVault.test.ts`) — it
does not and cannot verify the real Keystore's behavior without a device.

### 4.12 Push notification development requirements

- **A physical device is required** — push tokens are not issued to the
  Android emulator, and `expo-notifications`'s permission request needs
  a dev-client or production build (not Expo Go).
- **First run**: `app/_layout.tsx` calls
  `registerForPushNotificationsAsync()` once a session token exists; it
  requests the Android notification permission, creates a default
  notification channel, and POSTs the resulting Expo push token to
  `POST /auth/push-token`.
- **EAS project id**: `Notifications.getExpoPushTokenAsync()` needs an
  EAS project id once one exists (`eas build:configure` in §4.2 option B
  writes it to `app.json`'s `expo.extra.eas.projectId` automatically);
  omitted, it still works for local `expo start --dev-client` sessions
  without EAS.
- **Backend side**: already real and tested (`12-bot-engine.md` §10) —
  what's untested here is the on-device permission prompt and the actual
  FCM delivery to a physical phone, which needs a device this sandbox
  doesn't have.
