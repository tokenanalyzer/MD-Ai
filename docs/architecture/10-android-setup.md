# Android Setup & Verification

## 0. Quick Start — get MD AI running on your phone (beginner-friendly)

This is the short version. Each step links to the detailed reference
section below it if something doesn't work.

### A. Requirements
- A physical Android phone with USB debugging available (Settings → About
  Phone → tap "Build number" 7× → Settings → Developer Options → USB
  debugging).
- Node 20+, [pnpm](https://pnpm.io), and either Android Studio (for a
  local build) or a free [Expo](https://expo.dev) account (for a cloud
  build) — see §C.2 below for which one you need.
- The MD AI backend running somewhere reachable from your phone: your own
  machine on the same Wi-Fi (§G), or an Oracle instance (§H).

### B. Install dependencies
```sh
git clone <this-repo-url> && cd md-ai
pnpm install
```
This installs the whole monorepo (backend, shared types, mobile) in one
step — no need to `cd` into `apps/mobile` first.

### C. Build a Development Build (do this once)

MD AI needs a **Development Build**, not plain Expo Go — it uses native
modules (secure storage, push notifications) Expo Go can't load. You only
redo this when a *native* dependency changes, not on every code change.

**C.1 — Local build** (you have Android Studio + the Android SDK):
```sh
cd apps/mobile
npx expo prebuild --platform android
npx expo run:android      # connect your phone via USB first
```

**C.2 — Cloud build** (no Android Studio needed — recommended if you
don't already have Android dev tools installed):
```sh
cd apps/mobile
npx eas-cli login                                    # free Expo account
npx eas-cli build:configure
npx eas-cli build --profile development --platform android
```
EAS builds in the cloud and gives you a QR code / link — open it on your
phone and install the `.apk` (allow "install from unknown sources" if
asked).

Neither path requires a paid service — EAS's free tier covers
development builds.

### D. Configure the backend URL
Point the app at your backend **before** starting the dev server — see §E
for exactly how. Two options:
- Fastest: `EXPO_PUBLIC_MDAI_BACKEND_URL=http://<your-LAN-IP>:8080` as an
  env var when you run `expo start` (§4.6).
- Or: leave it unset, launch the app, and set it from the in-app
  **Settings screen** (⚙ icon next to Vault on the Chat screen) — no
  rebuild needed, takes effect on your next chat/WS connection.

### E. Start Expo
```sh
cd apps/mobile
EXPO_PUBLIC_MDAI_BACKEND_URL=http://<your-LAN-IP>:8080 npx expo start --dev-client
```
Scan the QR code using the **dev-client app** you installed in step C
(not the phone's camera app, not Expo Go).

### E2. Web preview — inspect the UI without a phone or a build (M6)
No Android build, no dev-client, no device needed to look at Command
Center/Chat/Agent/Model/Memory/Tools UI structure and iterate on it:
```sh
cd apps/mobile
EXPO_PUBLIC_MDAI_BACKEND_URL=http://localhost:8080 pnpm web
```
Opens in your desktop browser via `react-native-web`. Real backend
required (same auth-guarded REST/WS contracts as the phone app — this is
not a mocked/demo mode), so start the backend first (§G, step 1). Push
notifications and the Android Keystore-backed secure vault degrade to
web-safe fallbacks or no-ops in this mode — use a real device (§A-§H) to
verify those specifically. Everything else (Command Center, Chat, Agent/
Model/Memory/Tools Centers, Settings) is the same code path as the native
app.

### F. Install the APK on Android
- Local build (§C.1): `expo run:android` installs it automatically over
  USB.
- Cloud build (§C.2): download the `.apk` EAS gives you and open it on
  the phone directly (a browser download, AirDrop-equivalent, or `adb
  install path/to/app.apk` if you have `adb` and a USB connection).

### G. Connect the phone to your local backend
1. Start the backend: `pnpm --filter @mdai/backend dev` (or `docker
   compose -f infra/docker/docker-compose.yml up`).
2. Find your dev machine's LAN IP: `ip addr` (Linux), `ifconfig` (Mac),
   `ipconfig` (Windows).
3. Confirm the phone can reach it: open
   `http://<your-LAN-IP>:8080/healthz` in the phone's browser — expect
   `{"status":"ok"}`.
4. Use that URL in §D/§E. Full detail: §4.9.

### H. Connect the phone to your Oracle backend
Once your Oracle instance is deployed (`08-deployment-architecture.md`),
use its public HTTPS URL the same way: `EXPO_PUBLIC_MDAI_BACKEND_URL=
https://<your-oracle-domain>` or the in-app Settings screen. No LAN
required — works over any internet connection. Full detail: §4.10.

### I. Common errors
| Symptom | Cause | Fix |
|---|---|---|
| App can't reach the backend at all | Used `localhost` in the backend URL | On a phone, `localhost` means the phone itself — use your machine's LAN IP or Oracle's domain (§D/§G/§H) |
| "Network response timed out" only on the phone, works in a browser on the same machine | Wi-Fi client isolation, or a firewall blocking Metro's port (8081) or the backend's port (8080) | Try `npx expo start --dev-client --tunnel` (§4.5) to route around it |
| Blank screen / immediately crashes on launch | Installed Expo Go instead of the dev-client build, or a stale dev-client after adding a new native module | Rebuild via §C after adding any new native dependency; make sure you scanned the QR from the **dev-client app**, not Expo Go |
| `expo install`/`eas build` hangs or errors on version lookups | This sandbox environment specifically blocks Expo's registry API — not expected on a normal machine with internet access | Retry on your own machine; if it recurs, check `apps/mobile/node_modules/expo/bundledNativeModules.json` for the SDK's known-good versions directly |
| Push token registration silently does nothing | Running in the emulator or via Expo Go, not a physical dev-client build | Push tokens require a real device + dev-client/production build (§4.12) |
| A provider API key isn't working | Not a backend-URL issue — check the Vault screen's connection-test error message | See `07-security-model.md` §3 for how keys are supposed to flow (device → backend, per-request, never stored) |

### J. How to switch backend environments
No code change, no rebuild, for either path:
- **Fastest for repeated dev-server restarts**: change the
  `EXPO_PUBLIC_MDAI_BACKEND_URL` value and restart `expo start
  --dev-client`.
- **Fastest without restarting anything**: open the in-app Settings
  screen, edit the URL field, tap "Save & use this backend" — takes
  effect on the next chat message or WS reconnect, persisted on-device
  so it survives app restarts too.

---

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

**Verified versions** (`apps/mobile/package.json`, cross-checked against
Expo SDK 52's own compatibility manifest —
`expo/bundledNativeModules.json` — not guessed):

| Package | Version | Notes |
|---|---|---|
| `expo` (SDK) | 52.0.49 | |
| `react` / `react-native` | 18.3.1 / 0.76.9 | |
| `expo-router` | ~4.0.0 | file-based navigation, already in use for every screen |
| `expo-secure-store` | ~14.0.0 | Android Keystore-backed vault (M1) |
| `expo-dev-client` | ~5.0.20 | the development-build native shell itself |
| `expo-notifications` | ~0.29.14 | push token registration (M5.13) |
| `expo-device` | ~7.0.3 | physical-vs-emulator detection, gates push registration |
| `expo-system-ui` | ~4.0.9 | applies `userInterfaceStyle: "dark"` natively — added this pass, see note below |

An earlier pass installed `expo-dev-client`/`expo-notifications`/
`expo-device` via a bare `pnpm add` with no version pin, which resolved
to their latest npm versions (57.x — Expo's own SDK-number-matched
release line, five majors ahead of this project's SDK 52). That's a real
native-ABI mismatch that would have broken the actual build; this pass
re-pinned all three to the exact SDK-52-compatible versions from Expo's
own bundled manifest and confirmed the fix with `npx expo prebuild`
(§4.2) succeeding cleanly. `expo-system-ui` was missing outright —
`expo prebuild` warned `userInterfaceStyle: Install expo-system-ui in
your project to enable this feature` (the dark-theme setting in
`app.json` wasn't fully applying natively without it); adding it cleared
the warning.

Already wired into this repo:
- `expo-dev-client` is a dependency (`apps/mobile/package.json`) and
  listed in `app.json`'s `plugins`.
- `eas.json` defines three build profiles: `development`
  (`developmentClient: true`, produces an installable `.apk`),
  `preview` (same, without the dev-client debug menu), `production`.

You do **not** need an EAS/Expo account to use a development build if you
build locally (§4.2 option A). You **do** need one for cloud builds
(§4.2 option B), which is the recommended path if you don't have Android
Studio/the Android SDK installed locally — and even then it's free (EAS's
free tier covers development builds; no paid plan required for this
workflow).

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
   Set it from the in-app **Settings screen** (the ⚙ icon next to Vault
   on the Chat screen) — no rebuild, no code change, takes effect on the
   next chat/WS connection.
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
package (`com.venom31.mdai`), so uninstalling/reinstalling the dev-client
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
