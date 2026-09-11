# Empire OS V2 — build notes

## Expo / React Native version

This project is pinned to **Expo SDK 51** (`expo` ~51.0.0, `react-native` 0.74.5,
`react` 18.2.0). Do not assume behavior from a newer SDK — several APIs changed
after 51 (`expo-av` split into `expo-audio`/`expo-video`, the New Architecture
default, `expo-file-system` next API, etc.). None of that applies here.

Expo no longer hosts versioned docs for SDK 51 (`/versions/v51.0.0/` 404s). When
you need to confirm an API:

1. Check the installed version — `package.json`, or
   `https://cdn.jsdelivr.net/npm/expo@51.0.39/bundledNativeModules.json` for the
   Expo-managed native module versions SDK 51 expects.
2. Read that exact package version's typings/README on npm/jsdelivr
   (e.g. `https://cdn.jsdelivr.net/npm/expo-font@12.0.10/build/Font.d.ts`).
3. Only then fall back to `https://docs.expo.dev/versions/latest/`, treating
   anything version-flagged as newer-than-51 with suspicion.

Key pinned native-module versions for SDK 51:

| Package | Version |
| --- | --- |
| expo-font | ~12.0.10 |
| expo-gl | ~14.0.2 |
| react-native-reanimated | ~3.10.1 |
| react-native-gesture-handler | ~2.16.1 |
| react-native-svg | 15.2.0 |
| expo-av | ~14.0.7 |
| expo-notifications | ~0.28.19 |
| expo-device | ~6.0.2 |
| expo-image-manipulator | ~12.0.5 |
| react-native-live-audio-stream | 1.1.1 |

`react-native-live-audio-stream` is a plain autolinked RN native module (not an
Expo module — no `expo-modules-core` dependency), added for A.R.A. LIVE below.
It needs no config plugin: it declares no permissions beyond `RECORD_AUDIO`,
already present via `expo-av`. Any change here needs a fresh native build (see
Builds below) — it will not ship OTA.

## A.R.A. LIVE — realtime duplex voice (`src/services/realtimeVoice.js`)

A true duplex voice call with A.R.A. over xAI's `grok-voice-latest` realtime
socket, separate from the turn-based hands-free loop in `CommandScreen.js`
(record → Whisper → text call → TTS → play). The mic streams continuously via
`react-native-live-audio-stream` (Android capture uses the `VOICE_COMMUNICATION`
audio source — hardware AEC, so the phone speaker's own output isn't picked back
up as input); the server's own VAD (`turn_detection: server_vad`) decides when
you're done talking and drives generation directly, and can interrupt her
mid-sentence the instant you start talking again (`input_audio_buffer.
speech_started` stops local playback — real barge-in, no separate "should I
reopen the mic" state machine).

Scope: she keeps live read access via realtime function calling
(`read_hud`, `query_memory`) so she isn't flying blind, but write-side command
tags (`SAVE_NOTE`, `REMEMBER`, canvas tags, web search, …) are NOT wired into
this session — those stay on the text turn. iOS echo cancellation depends on
the library's own `AVAudioEngine` capture and hasn't been verified as strong as
Android's `VOICE_COMMUNICATION` source — worth a real check on iOS hardware
before trusting it hands-free with speaker output.

Toggled per-persona ("GO LIVE" in A.R.A.'s direct chat) — every other persona
still uses the turn-based loop.

## Backend (`server/`)

Node/Express on a Replit Reserved VM (always-on: nudge/briefing/council crons).
Postgres via `sync_rows` — a generic last-write-wins JSON row store the app syncs
to; the server reads/writes app tables (`tasks`, `notes`, …) as JSON blobs
without knowing their shape. AI keys live here; the app's `/ai/<provider>` proxy
forwards with them. See `DEPLOY_BACKEND.md` (gitignored — holds the real token).

**Telegram bots** — `server/telegram.js` + `server/personaRuntime.js` +
`routes/telegram.js` run **one bot per persona** (A.R.A., S.T.E.P.H.A.N.I.E.,
H.A.V.E.N., J.A.R.V.I.S., S.E.L.E.N.E.), each a headless front door to that
persona. Server-side re-implementation of a persona's turn: context from
`sync_rows`, per-persona history in `tg_messages.persona`, a subset of the app's
command tags (notes, web/deep research, memory, `[RELAY_TO]`, `[READ_HUD]`,
`[BUILD_STATUS]`; A.R.A. also has tasks/expenses/dates/council). App-only tags
(3D Lab, HUD edits, trades, build requests) are deferred back to the app. Each
bot's token is `TELEGRAM_BOT_TOKEN[_PERSONA]`; all locked to `TELEGRAM_OWNER_ID`;
webhook at `/telegram/webhook/:persona/:secret`. Voice notes both ways: Whisper
in (`OPENAI_API_KEY`); out is xAI `grok-voice` for A.R.A. (`server/araVoice.js`,
`XAI_API_KEY`) and ElevenLabs for the rest (`server/personaVoice.js`,
`ELEVENLABS_API_KEY`), OGG/Opus via bundled `ffmpeg-static`. See `server/README.md`.

**S.C.O.U.T. signals** — `server/autoScout.js` + `server/scoutSignals.js` are an
always-on cron (`SCOUT_CRON=on`) that walks the metro×segment grid
(`server/scoutTargets.js`), pulls free buying-intent signals (job postings via
Adzuna, review velocity via Yelp), qualifies against Empire Digital's ICP with
one Claude call, scores each `leads.heat` 0-100, and writes warm leads into
`sync_rows`. Discovery only — the app-side `src/services/autoScout.js` still owns
outreach and now works highest-heat leads first.

## Builds

Android APK via EAS (`eas build --platform android --profile preview`), also
wired through GitHub Actions on push to `main`. Any change that adds or updates a
native module (fonts, `expo-gl`, `reanimated`, …) requires a fresh native build —
it will not ship as an OTA update.
