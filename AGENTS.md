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

## "Aura" is always A.R.A.

Speech-to-text hears "Ara" as "Aura". Whisper gets the persona names as its
`prompt` (vocabulary), and `fixNames` (`server/llm.js`, mirrored in
`src/services/aiService.js`) rewrites "aura" → "Ara" in every transcript —
Telegram voice notes, typed Telegram text (`runPersonaTurn`), the app's voice
loop and GO LIVE's transcripts; GO LIVE's prompt also tells her "Aura" is her.

## Persona names spoken as names; relays stay theirs

`speakNames` (`server/voiceCues.js`, mirrored in `src/services/voiceCues.js`)
turns "J.A.R.V.I.S." / "JARVIS" into "Jarvis" before any voice reads it (only
persona names; other acronyms untouched): `voiceNote`, the app's
`textToSpeech` / `speak` / `speakAs`, and GO LIVE's prompt. Another persona's
words passed through A.R.A. stay theirs: `ARA_SCRIPT` (both copies) and
`araScript`'s relay hint (`relayFrom`) make her say "Talon says he…", and his
words stored in her history or memory are labeled as his (a T.A.L.O.N. reply
saved under the owner's message was being read back as the owner's).

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
H.A.V.E.N., J.A.R.V.I.S., S.E.L.E.N.E., A.I.S.H.A.), each a headless front door to that
persona. Server-side re-implementation of a persona's turn: context from
`sync_rows`, per-persona history in `tg_messages.persona`, and the app's command
tags ported to `server/personaTools.js`. Every persona gets web/deep research,
memory, `[RELAY_TO]`, Drive notes and Sheets. **Calendar and Gmail are A.R.A.'s
alone** (`ARA_ONLY_READS` / `ARA_ONLY_WRITES` in `server/personaRuntime.js`,
`araOnly` in `src/services/googleCommands.js`): anyone else's calendar/email
tags are dropped with a ⚠️, their prompt tells them to `[RELAY_TO: ara | …]`,
and `relayAllowed` lets a calendar/email hand-off to her through. A.R.A. also has tasks (+ Google Tasks), expenses, revenue,
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
the phone, 3D Lab, HUD panel layout, the Canvas, hand-placed trades and
clips/video watch. J.A.R.V.I.S. (and A.R.A.) run the Claude Code build loop
from Telegram too (`server/buildAgent.js`, needs `GITHUB_TOKEN` — the same PAT
as the app's Settings › Dev): `[BUILD_REQUEST]` → Confirm tap → `@claude`
issue → `claude.yml` → PR; `[BUILD_REPLY]` answers its questions,
`[BUILD_MERGE]` (Confirm tap) merges into `main` and starts the APK build. Jobs
are the app's synced `build_jobs` rows, so both sides see them; a 3-min cron
(`BUILD_POLL=off` to stop) tells him on J.A.R.V.I.S.'s bot when one asks, opens
a PR, fails or ships. Without `GITHUB_TOKEN`, `[BUILD_REQUEST]` saves the spec
as a note. Each
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
The check lives inside each `start*` function itself, so a Settings toggle's
`refresh*` can't start a local loop while a backend is linked.
TradeLocker's login travels to the server the same way the Google refresh
token does (`POST /trade/creds`, `server/routes/trade.js`, table
`trade_creds`) — pushed on TradeLocker connect, backend connect, and app
start (`syncTradeCredsToBackend()` in `src/services/tradeLocker.js`).

**T.A.L.O.N. trades gold (XAUUSD) and Bitcoin (BTCUSD) only**, on a fixed
playbook in `server/talonBrain.js` (`STRATEGY`, `SYMBOLS`). He holds every trade to its stop or
target — a "close" from his brain is ignored — and `guardStop()` keeps
every stop (his and W.I.R.E.'s news trades) at least gold $10 / Bitcoin 0.8% and
1.2× the 1H ATR14 from entry, skipping the trade if the targets then pay too
little. Every setup goes in as a scalp + swing pair (two 0.02 positions, same
entry and stop; scalp → next 15m level at 1R+, swing → next 4H level at 3R+;
no valid swing → scalp alone, which needs 2R;
linked by `pair_id` in `trades`); when the scalp pays, `reconcileOpenTrades`
moves the swing's stop to break-even. Every Bitcoin trade (setups and news trades) is
entered `ENTRY_COPIES` = 2 times (gold once — `entryCopies()` in `server/tradeLocker.js`), each scalp + swing copy with its own `pair_id`,
capped by `MAX_PAIRS` at 1 scalp + swing pair open at once on gold (so a gold paired setup goes in once) and 2 on Bitcoin (a pair
counts only while its scalp is open — once the scalp pays, the swing alone
frees the slot; a setup that would top the cap goes in with fewer copies or is
skipped). Lone scalps, news trades and add-ons don't count toward it. On the way to the target he
adds, on pullbacks only: every 1R a setup (all its copies share a `setup_id`) reaches toward its
final target arms an add, and `addOnEntries` in `server/talonAutoTrade.js` puts it in
only once price has pulled back 0.5R off the setup's best price (its low staying 0.25R+
above the add's stop) and then turned back toward the target by 0.2R off that pullback's
low — never while price is still falling away from the TP; a new best price restarts the pullback —
one 0.02 position (`setup: 'add'`, `add_level`, not doubled by `ENTRY_COPIES`)
that takes profit 1R past its entry, with the stop one step behind the armed step (first add's stop = the setup's entry), no
cap on adds per setup, never within 1R of the target. It runs on every 5-min tick, with no AI calls.
**Setups' bias is 4H + 1H** (`STRATEGY` rule 1). Rule 10 reads the 1D: a setup
against the daily trend must be called a `"daily":"reversal"` by his brain to
keep its swing — otherwise it's a pullback and goes in scalp-only (2R),
enforced in `talonAutoTrade.js`. His market updates say with / pullback / reversal.
**Quick scalps** (`server/talonQuick.js`, `TALON_QUICK=off` to stop; every filter
fire and its outcome is logged to `app_settings.talon_quick_log`, read with
`[QUICK_LOG]`; the brain's default is to take a fired setup) are a separate 5m desk on the same
5-min tick: a coded filter (1H + 15m trend agree, pullback into the 5m EMA20, a closed 5m rejection
bar) and only when it fires one AI call to confirm and pick the target (1.5R min, capped at 3R).
Stop beyond the key level, sized for the 5m: past the zone (5-bar swing, 5m EMA20, a round number
with them) + one 5m ATR, min gold $3 / Bitcoin 0.3%; over gold $8 / Bitcoin 0.8% → skip; stop to
break-even at +1R. One 0.02 position (`setup: 'quick'`), one open per
market, never against an open position there; gold 3 AM-12 PM ET only, both off 8:25-8:45 AM ET
weekdays; 2 quick losses in a row → 1 h off that market, 3 in a day → done for the day. No add-ons,
not doubled, not counted in `MAX_PAIRS`, skipped by the near-stop watch.
**On his orders** (`server/talonCommands.js`): A.R.A. relays "tell Talon to…" (or
any trade order — `TRADE_ORDER` in `relayAllowed` lets one through to T.A.L.O.N.
unnamed) and he emits `[TRADE_POSITIONS]`, `[TRADE_ENTER: SYM | side | stop |
target]`, `[TRADE_CLOSE: id|SYM|all]`, `[MOVE_STOP: … | price|breakeven]`,
`[MOVE_TP: … | price]`, `[TRADE_ACCOUNT: live|demo]` — T.A.L.O.N. only (other
personas get a ⚠️). Demo runs at once; on a live account, and switching to
live, it's a `tg_pending` Confirm tap (`talon_*` kinds in `runPending`). Hand
entries are `setup: 'manual'`; levels he moves are written to the journal too;
a close he ordered is `closed_by: 'owner'` so the close alert doesn't say "I
didn't close this one". The main stop rule minimum still applies; a stop can't
be removed. Account switching: `POST /trade/creds` also keeps one login per
type (`trade_creds` rows 2 = demo, 3 = live; row 1 = last pushed), and the
synced `talon_account` setting picks which one `loadTradeCreds` uses (a new or
changed login from the app makes itself active; the app re-posting the same
login on start doesn't). `[TRADE_ACCOUNT]` sets `talon_account` + `talon_live`.
**Live account:** demo by default; Settings › Trading › LIVE TRADING (needs a
connected live TradeLocker login, confirm dialog) writes `talon_live` = `1`
(synced), which lets the auto-trade loop and W.I.R.E.'s news trades place
orders on a live account. Without it a live login halts auto-trade as before.
Alerts are tagged 🔴 LIVE. `POST /trade/creds` resets the server's TradeLocker
session so a demo → live switch takes effect at once. The "Winning
Strategy" note, the `auto_trade_symbols` setting and his custom persona prompt
(`custom_prompts`, blocked in both `personaRuntime.customPrompt` and the app's
`buildSys`) are deliberately ignored. W.I.R.E.'s news hand-offs are filtered to
the same two symbols. Every open, close (stop/target hit, checked every 5 min),
rejected order and a 9 PM ET recap go to the owner from A.R.A.'s Telegram bot
(`server/talonAlerts.js`, also logged in her `tg_messages` history) — each as
a voice note from her, then the text. T.A.L.O.N. places his own orders; A.R.A.'s
`[TALON_RUN]` (and `/talon` on her bot) runs a scan now and reports what he
decided. At 9:30 AM / 12:30 PM / 3:30 PM / 6:30 PM ET (`TALON_UPDATE_HOURS`, on the half hour,
`TALON_UPDATES=off` to stop) he relays a market update to A.R.A.
(`server/talonUpdate.js`, one AI call, never trades): per market his read, his
prediction for the next several hours (target and invalidation levels) and how
our open positions look. She sends it on her bot like the trade alerts and it's
saved to her `persona_memory`; her `[TALON_UPDATE]` gets one on demand, and the
morning brief carries one too (`talonSection` in `server/morningBrief.js`). A cycle where nothing could be decided (credits out, no quotes) alerts
once instead of only logging. On every 5-min tick `server/talonWatch.js` (no AI
calls, `TALON_WATCH=off` to stop) has him relay anything unexpected to A.R.A.,
once each: a setup 75%+ of the way to its stop, a 15m candle over 2× the 15m
ATR14 on gold or Bitcoin, price through the invalidation level of his last
market update (the update ends in a `LEVELS:` JSON line, stripped and saved to
`app_settings.talon_update_levels`), a position with no stop, and the loop
itself failing (`systemFault`/`systemOk`). `tradeClosed` flags a close nowhere
near the stop, target or break-even as one he didn't make.
**The main stop rule's minimum is on every order except quick scalps and add-ons** — gold $10 /
Bitcoin 0.8% and 1.2× the 1H ATR14 from entry (`minStopDist`, server and app `tradeLocker.js`).
Setups and news trades size their stop to it up front, and both `tlPlaceOrder`s widen any closer
stop as a backstop (chat trades say so); quick scalps and add-ons keep their own stops (`minStop: false`).
Stops are never optional: both `tlPlaceOrder`s round stop/target to the
instrument's `pricePrecision` (an off-tick stop can be dropped while the
market order fills), the app's refuses an order with no stop, and modifies send
`stopLossType`. Every 5-min reconcile runs `ensureStop` (`server/tradeJournal.js`)
on each of his open positions: no stop on the broker → the journal stop is put
back, or the position is closed if price is already through it. The cron runs on any of the Claude subscription,
`ANTHROPIC_API_KEY` or `XAI_API_KEY` (his brain is `claudeText`'s chain). W.I.R.E.'s
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

**Except A.R.A.:** she runs the team, so her relays always go through
(`relayAllowed(text, id, from)` passes when `from === 'ara'`) and her prompt
carries `ARA_ROUTE` (who owns what — keep `server/personas.js` and
`src/personas/personas.js` in sync): "make me a logo" goes to S.E.L.E.N.E.,
"close the gold trade" to T.A.L.O.N., without him naming anyone. Questions and
opinions she still answers herself unless they need someone's live tools.

For everyone else, a persona's `[RELAY_TO]` only goes through when the owner's message asks for it:
it names the target persona or plainly asks for a hand-off ("check with", "run
it by", "loop in"…). `relayAllowed()` in `server/personas.js` and
`src/personas/personas.js` (keep in sync) gates it on both the server (Telegram)
and in the app; a blocked relay tells the persona to answer it herself. Code-level
hand-offs he set up (W.I.R.E.'s 8:30 desk → T.A.L.O.N., `[DELEGATE]`, the
council) aren't affected.

A relay can carry an order, not just a question: "tell J.A.R.V.I.S. to…", "have
S.E.L.E.N.E. make…" → `[RELAY_TO: id | the full instruction]`. On Telegram the
relayed persona gets A.R.A.'s shared write set (`SHARED_OPS` in
`server/personaRuntime.js`: tasks, money, dates, HUD, leads) on top of its own
tools — `applyEffects(…, { full: true })` — and any image/diagram/file it makes
goes out on the asking bot (`sink.media`). T.A.L.O.N. relayed can run
`[TALON_RUN]` / `[TALON_UPDATE]` himself.

## J.A.R.V.I.S. reads the code (`server/codeAccess.js`)

With `GITHUB_TOKEN` set it reads GitHub `main` (tarball, re-checked every 2
min, re-downloaded when main moves — so a merged PR is visible within minutes,
before any redeploy); otherwise the deployed checkout, and the brief says which.
His Telegram prompt (and a relay to him) carries `empireOsBrief()` — this file
plus the source file map — and he has read-only code tags: `[SEARCH_CODE: text]`,
`[READ_CODE: path | page]`, `[CODE_TREE: folder]` (A.R.A. too). Text files only;
`DEPLOY_BACKEND.md` and other gitignored secrets never show. Changing code still goes through `[BUILD_REQUEST]`.

## Self-updating server + J.A.R.V.I.S.'s [REDEPLOY] (`server/boot.js`, `server/redeploy.js`)

`npm start` runs `boot.js`, a supervisor that runs `index.js` as a child. Each
start it downloads GitHub `main` (tarball, `GITHUB_TOKEN`) into
`$TMPDIR/empire-live/<sha>`, shares `node_modules` when the dependencies match
(else `npm ci`), starts it and waits for `/health`. A copy that doesn't come up
within 150s falls back to the last good copy, then to the bundled deploy, and
the child gets `EMPIRE_FALLBACK_ERROR`. `SELF_UPDATE=off` runs the bundled code
only. A redeploy is the child exiting with 75: J.A.R.V.I.S.'s `[REDEPLOY]` →
Confirm tap → `requestRedeploy` writes `app_settings.redeploy_pending`, fires a
`repository_dispatch` (`server-redeploy`) and exits; boot pulls main and
restarts. Replit's process never exits, so this doesn't depend on Replit
restarting anything. On the way up `onBoot()` has A.R.A. report on Telegram:
live or fell back (with the error), time taken, the commit running and the
commit list since the last version. `.github/workflows/server-check.yml` (run by
that dispatch) checks `/health` → `code.booted_at` ~6 min later and fails, which
emails the owner, if the server never came back. It needs `PUBLIC_URL` (or
`REPLIT_DOMAINS`) and a token with Contents write. `/health` now carries `code`
(sha, source, supervised, booted_at, fell_back). `[BUILD_MERGE]`'s receipt says what the
merge set off from the PR's files (`whatShips` in `server/buildAgent.js`, same
rules as `build.yml`'s paths-ignore): app files → APK build; server-only → no
APK, `[REDEPLOY]` to go live; both → both. Secrets/env changes still need
Replit's Deployments panel. The first switch to this needs one manual Replit
redeploy.

## Drive notes and calendar edits (server)

Calendar times go through `parseWhen` (`server/when.js`, mirrored in
`src/services/when.js` — keep in sync): ISO, "Friday 3pm", "tomorrow 10:30am",
"Nov 6 2pm", date and time in separate tag fields, a bare date = all-day. (Before
this, "2026-11-06 | 15:00" made a midnight event and "3:00 PM" became 3 AM.)
`[CREATE_EVENT: title | when | minutes | location | notes]`. A reply that says
something is on the calendar with no event tag behind it gets a ⚠️.

`saveDriveNote` only matches notes (markdown / text / Google Doc, never a folder
or Sheet), creates new notes straight into My Drive (no folder — he asked for
that), writes a Google Doc as plain text, and returns the file's link for the
receipt. Edits never move a note (the app's old "migrate-on-touch" into the
Empire OS Notes folder is gone). `[MOVE_NOTE: note | folder]` (`driveMoveNote`,
server + app) files a note on request: an existing folder by name, nested
"A/B" created as needed, "My Drive" for the top. `[SYNC_NOTES]` (Obsidian
folder) only runs when he asks. `[EDIT_EVENT: title or id | title=;
start=; minutes=; location=; notes=]` (`calendarUpdate` in `server/google.js`)
edits an event in place — A.R.A. only, no confirm (deletes still confirm).

## Telegram reply guards

A reply's media tags (`[GENERATE_IMAGE]`, `[DIAGRAM]`, `[CHART]`, `[SEND_*]`) are
sent by `routes/telegram.js` after the text via `sendMedia`. Persona turns run at
`maxTokens: 4000`; a tag that never closes (reply cut off mid-note) still runs
to the end of the reply with a ⚠️, and a reply that says a note was saved with
no note tag behind it gets a ⚠️ too.

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
