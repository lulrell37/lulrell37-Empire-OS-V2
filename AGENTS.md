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

## Emotion in every voice (`src/services/voiceCues.js`, `server/voiceCues.js`)

Every persona prompt, app and Telegram, carries an EMOTION block telling them
to talk like a person, not read a script. It also lets them write lowercase
voice cues (`[laughs]`, `[sighs]`, `[softly]`). Command tags are always
UPPERCASE, which is how the two are told apart. Cues are stripped from all
displayed or saved text (`stripCommands` in the app calls `rememberCued`;
`runPersonaTurn` on the server returns `text` plus `spoken`) but reach the
voice. ElevenLabs runs on `eleven_v4_turbo`, which performs the cues. If the
account or voice gets a 400/422 it falls back to `eleven_flash_v2_5` with cues
stripped and `style` turned up. Grok voice (A.R.A.) is told to act the cues out.
Keep the two EMOTION blocks in sync.

Except J.A.R.V.I.S.: `emotionFor()` gives him a STEADY block instead (composed,
no cues), and his ElevenLabs voice runs cue-free at high stability (`isFlat()`).

A.R.A.'s voice is ElevenLabs voice `rtx7URANE3SCNaOJwq5w` (looser `ARA_SETTINGS`
for range). Every voiced reply goes through a script pass first: her Grok brain,
with `ARA_VOICE` (soft, warm, slightly seductive, playful, slightly flirty, a touch unhinged) + `ARA_SCRIPT`,
rewrites the reply as what she'd say out loud with lowercase emotion cues, and
ElevenLabs performs that (`araSpokenScript` in `src/services/aiService.js`,
`araScript` in `server/personaVoice.js`; the morning brief's own spoken script
skips it). GO LIVE still uses Grok's realtime `ara` voice with `ARA_VOICE`. The old
Grok-voice path is kept whole and one switch away: Settings › AI › A.R.A.'s
Voice writes `app_settings.ara_voice` = `grok` (synced), which puts the app
(`araGrokRealtimeVoice` in `CommandScreen.js`, `grokVoiceUri` in `labVoice.js`)
and Telegram (`synthesizeAraVoice` in `server/araVoice.js`) back on it. Keep
`ARA_VOICE` / `ARA_SCRIPT` in sync between `src/services/voiceCues.js` and
`server/araVoice.js`.

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
`sync_rows`, per-persona history in `tg_messages.persona`, and the app's command
tags ported to `server/personaTools.js`. Every persona gets web/deep research,
memory, `[RELAY_TO]` and the full Google set (Drive notes, Gmail read/send,
Calendar, Sheets). A.R.A. also has tasks (+ Google Tasks), expenses, revenue,
targets, dates, HUD edits (score, routine, Batman Protocol, word/verse/fact),
the leads pipeline, the council, and THE FIRM (`[PROJECT_START]`, `[DELEGATE]`
runs the specialists server-side). Send-email and deletes become `tg_pending`
rows and need a Confirm tap (inline buttons → `callback_query`). Each reply
carries a ✓/⚠️ receipt per write, and the prompt carries a live Google status
line (`googleStatus()`, also `GET /google/status`) so a persona never claims a
Drive save that fell back to the app's notes. Replies go out as Telegram HTML (markdown links are tappable), and every
persona can send media (`server/telegramMedia.js`): `[SEND_PHOTO]`,
`[GENERATE_IMAGE]` (Pollinations, free/keyless, ~1 per 45s; xAI then OpenAI as backups), `[DIAGRAM]` (Mermaid via Kroki),
`[CHART]` (Chart.js via QuickChart), `[SEND_FILE]`/`[SEND_VIDEO]`/`[SEND_AUDIO]`,
`[SEND_LOCATION]`; `[WEATHER]` is a keyless Open-Meteo read. ElevenLabs voice
notes retry, fall back to OpenAI TTS, and say so in the chat when none went out
(`voiceNote()` in `server/personaVoice.js`). Still app-only: opening apps on
the phone, 3D Lab, HUD panel layout, the Canvas, trades, clips/video watch, and
filing GitHub builds (the token lives on the device — `[BUILD_REQUEST]` saves
the spec as a note instead). Each
bot's token is `TELEGRAM_BOT_TOKEN[_PERSONA]`; all locked to `TELEGRAM_OWNER_ID`;
webhook at `/telegram/webhook/:persona/:secret`. Voice notes both ways: Whisper
in (`OPENAI_API_KEY`); out is ElevenLabs for everyone, A.R.A. scripted by Grok first (`server/personaVoice.js`,
`ELEVENLABS_API_KEY`), OGG/Opus via bundled `ffmpeg-static`. See `server/README.md`.

**S.C.O.U.T. signals** — `server/autoScout.js` + `server/scoutSignals.js` are an
always-on cron (`SCOUT_CRON=on`) that walks the metro×segment grid
(`server/scoutTargets.js`), pulls free buying-intent signals (job postings via
Adzuna, review velocity via Yelp), qualifies against Empire Digital's ICP with
one Claude call, scores each `leads.heat` 0-100, and writes warm leads into
`sync_rows`. Discovery only — outreach is a separate module (below) that works
highest-heat leads first.

**Server-side ports of the app's four "autonomous" loops** — T.A.L.O.N.
auto-trade, W.I.R.E.'s news desk, S.C.O.U.T.'s cold-outreach loop (distinct
from the signal-discovery cron above), and A.T.L.A.S.'s unprompted money
review were originally plain `setInterval` timers in `src/services/`, started
and stopped by `App.js` on foreground/background — meaning all four died the
moment the app was closed. Each now has a server-side twin
(`server/talonAutoTrade.js`, `server/newsWire.js`, `server/scoutOutreach.js`,
`server/autoAtlas.js`, wired into crons in `server/index.js`) that reads/writes
the same `sync_rows` tables and the same `app_settings` toggles the app's own
Settings screen already writes — so flipping a toggle in the app controls the
server loop too, no separate on/off surface. Each also has its own
`TALON_AUTOTRADE` / `NEWS_WIRE` / `SCOUT_OUTREACH` / `AUTO_ATLAS` env kill
switch (default on) for this deployment specifically.

The app and the server must never run the same loop at once — that would
double every order/email/brief — so `App.js` only starts the four local loops
when `loadBackend()` finds no backend configured; once one is linked the
server becomes the sole actor and the client-side versions in `src/services/`
stop starting at all (`SettingsScreen.js`'s backend connect/disconnect
handlers flip this immediately rather than waiting for the next foreground).
TradeLocker's login travels to the server the same way the Google refresh
token does (`POST /trade/creds`, `server/routes/trade.js`, table
`trade_creds`) — pushed on TradeLocker connect, backend connect, and app
start (`syncTradeCredsToBackend()` in `src/services/tradeLocker.js`).

**T.A.L.O.N. trades gold (XAUUSD) and Bitcoin (BTCUSD) only**, on a fixed
playbook in `server/talonBrain.js` (`STRATEGY`, `SYMBOLS`). The "Winning
Strategy" note, the `auto_trade_symbols` setting and his custom persona prompt
(`custom_prompts`, blocked in both `personaRuntime.customPrompt` and the app's
`buildSys`) are deliberately ignored. W.I.R.E.'s news hand-offs are filtered to
the same two symbols. Every open, close (stop/target hit, checked every 5 min),
rejected order and a 9 PM ET recap go to the owner from A.R.A.'s Telegram bot
(`server/talonAlerts.js`, also logged in her `tg_messages` history). W.I.R.E.'s
8:30 AM ET data desk (`runEconDesk` in `server/newsWire.js`, `ECON_DESK=off` to
stop) reads CPI/jobs/claims/etc. vs forecast and hands a gold BUY/SELL to
T.A.L.O.N. on a clear surprise. Every W.I.R.E. news brief (breaking or on request) also goes to the
owner on Telegram from A.R.A. (`araNote`). The morning brief's GOLD WATCH section
(`goldWatchSection` in `server/morningBrief.js`) lists that day's gold-moving
events with forecasts.

One real gap this surfaced: the app's own per-persona chat table (`messages`
in `src/services/database.js`) is **not** part of the synced dataset, so a
server-side write can't land "in her chat" the way the on-device loops do.
A.T.L.A.S.'s auto-review — whose entire point was showing up unread in her
chat — is delivered as a push notification instead when run server-side
(`pushSender.pushAlert`), plus a `persona_memory` row so the context still
carries into her next real conversation. W.I.R.E.'s brief and T.A.L.O.N.'s
trades don't have this problem: they land in `hud_state` and `trades`, both
already synced and already what the NEWS panel and Trade Journal UI read.

## Persona hand-offs only on request

A persona's `[RELAY_TO]` only goes through when the owner's message asks for it:
it names the target persona or plainly asks for a hand-off ("check with", "run
it by", "loop in"…). `relayAllowed()` in `server/personas.js` and
`src/personas/personas.js` (keep in sync) gates it on both the server (Telegram)
and in the app; a blocked relay tells the persona to answer it herself. Code-level
hand-offs he set up (W.I.R.E.'s 8:30 desk → T.A.L.O.N., `[DELEGATE]`, the
council) aren't affected.

## Builds

Android APK via EAS (`eas build --platform android --profile preview`), also
wired through GitHub Actions (`.github/workflows/build.yml`) on every push to
`main` (server-only and docs-only pushes skip it; also runnable by hand). There
is no OTA path — the app has no `expo-updates` — so app changes reach the phone
only through a new APK. Any change that adds or updates a
native module (fonts, `expo-gl`, `reanimated`, …) requires a fresh native build —
it will not ship as an OTA update.

**"Push it" means ship it:** when the owner says push, commit, merge into
`main` and push, so the APK build starts. Pushing only the feature branch
builds nothing.
