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
persona names; other acronyms untouched; and, as he says them, Tarell → "Tah-rell" and Ara → "Ar-rah", owner 2026-11-20 — `relayFrom` accepts "Ar-rah"): `voiceNote`, the app's
`textToSpeech` / `speak` / `speakAs`, and GO LIVE's prompt. Another persona's
words passed through A.R.A. stay theirs: `ARA_SCRIPT` (both copies) and
`araScript`'s relay hint (`relayFrom`, `relayHint`, which recognizes every persona off `ROSTER` and gives their real pronouns and role; the script pass in both copies also carries the team list) make her say "Talon says he…", and his
words stored in her history or memory are labeled as his (a T.A.L.O.N. reply
saved under the owner's message was being read back as the owner's).

She also doesn't read a relay out on her ElevenLabs voice: she catches him up on it
in her own sentences, because the full message is in the chat. Short messages stay
short; anything over `ARA_LONG_CHARS` (1200 characters, relay or her own reply) gets a
very detailed summary instead — every point, number, level, name and time, ending with
what he has to act on, up to ~550 words (`araLongHint`, in both `ARA_SCRIPT` copies;
more script tokens and time for those). Long audio is voiced in sentence-split pieces
joined into one note (`ttsChunks`), never cut off at the TTS limit; the app allows
A.R.A.'s script 4000 characters. Alerts
from the desks (`sendFromAra`, `relay: true`) count as relays when a persona is named
on their first line. If Grok can't write the script, Claude does; if neither can, she
says whose message it is and gives the start, plus the lines with numbers on a long one (`relayFallback`). `node server/scripts/test-ara-relay.js` covers this.

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

A.R.A.'s voice is ElevenLabs voice `cpYoYR8FdKZd8Hpux2dU` (looser `ARA_SETTINGS`
for range). Every voiced reply goes through a script pass first: her Grok brain,
with `ARA_VOICE` (sultry, seductive, slightly flirty and a touch unhinged) + `ARA_SCRIPT`,
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

**Owner's voice switch:** `[ARA_VOICE_ENGINE: elevenlabs|grok]` writes the same synced `app_settings.ara_voice` as Settings › AI › A.R.A.'s Voice. `voiceToggleAllowed` (`server/personas.js`, `src/personas/personas.js`, keep in sync) lets it through only for J.A.R.V.I.S., on a message Mr. Burrus sent him directly that mentions her voice: only the owner's own turn passes `ownerText`, so relays, the council and the loops can't.

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
and `relayAllowed` lets a calendar/email hand-off to her through. A.R.A. also has tasks (+ Google Tasks — `[ADD_TASK]` mirrors there too now, server and app, not only `[CREATE_TASK]`), expenses, revenue,
targets, dates, HUD edits (score, routine, Batman Protocol, word/verse/fact),
the leads pipeline, the council, and THE FIRM (`[PROJECT_START]`, `[DELEGATE]`
runs the specialists server-side). Send-email and deletes become `tg_pending`
rows and need a Confirm tap (inline buttons → `callback_query`); every card is read out word for word
as a voice note first (`confirmScript`). Each reply
carries a ✓/⚠️ receipt per write, and the prompt carries a live Google status
line (`googleStatus()`, also `GET /google/status`) so a persona never claims a
Drive save that fell back to the app's notes. Replies go out as Telegram HTML (markdown links are tappable), and every
persona can send media (`server/telegramMedia.js`): `[SEND_PHOTO]`,
`[GENERATE_IMAGE]` (Pollinations, free/keyless, ~1 per 45s; xAI then OpenAI as backups), `[DIAGRAM]` (Mermaid via Kroki),
`[CHART]` (Chart.js via QuickChart), `[SEND_FILE]`/`[SEND_VIDEO]`/`[SEND_AUDIO]`,
`[SEND_LOCATION]`; `[WEATHER]` is a keyless Open-Meteo read. ElevenLabs voice
notes retry, fall back to OpenAI TTS, and say so in the chat when none went out
(A.R.A. tries her Grok voice before OpenAI; `voiceNote()` in `server/personaVoice.js`). Still app-only: opening apps on
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

**Build failures say why:** `claude.yml` sets no turn limit and hides the action's output, so when a run fails it posts the result's real reason as a `Reason:` line, and `failureText` (`server/buildAgent.js`, mirrored in `src/services/buildJobs.js`) reports it. A run that dies inside a minute never did any work, so it says retry, not "make it smaller". `[BUILD_REPLY]` re-runs a failed job.

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
linked by `pair_id` in `trades`; every target he sets, scalp, swing and quick scalp, is placed 10% of the way back toward the entry from the level he chose, `TP_PULL_IN` / `pullInTarget` in `talonBrain.js`, env `TALON_TP_PULL_IN`, with the minimum-R checks made on his level so no trade is lost to it, re-entries keep the journal's already-pulled targets, add-ons are untouched; owner's call 2026-11-19; and a new target within gold $3 / Bitcoin 0.3% (never over a quarter of its distance from entry) of one his open trades or resting quick limits on that market and side already use is set to that same price, `snapTarget` / `sharedTarget(s)` in `server/tradeJournal.js`, on setups, news trades, quick scalps and re-entries); when the scalp pays, `reconcileOpenTrades`
moves the swing's stop to break-even. Every Bitcoin trade (setups and news trades) is
entered once (`ENTRY_COPIES` = 1, `entryCopies()` in `server/tradeLocker.js`; Bitcoin was doubled until 2026-11-22, owner's call), each scalp + swing with its own `pair_id`,
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
**Re-entry after a stop hunt** (`server/talonReentry.js`, `TALON_REENTRY=off` to stop, on the 5-min tick, no AI calls): when one of his setups (scalp / swing / lone scalp — not quick scalps, add-ons, news or hand trades) closes at its stop with nothing of it still open, he watches that market for 4 h. He gets back in **once** if price went no more than 1× the 1H ATR14 past the old stop (deeper = breakdown, watch ends), a closed 15m candle closes back on the trade's side of it, and the 4H still agrees: new stop = the sweep's extreme + 0.2× ATR, then `guardStop` like any setup; the original targets, the furthest paying 2R+ from the new entry; one copy (not doubled on Bitcoin), scalp + swing when valid, counted in `MAX_PAIRS`. Re-entry trades carry `setup_id` `<setup>:re` and never start a watch of their own. A.R.A. tells him when a watch starts, when he re-enters and why, and when a watch ends without one (expiry stays quiet). State: `app_settings.talon_reentry`. `node server/scripts/test-talon-reentry.js`.
**Setups' location is checked in code** (`entryLocation` in `server/talonBrain.js`, run before `guardStop`): the price he'd actually get has to be within 0.5× the 1H ATR14 (`LOCATION_ATR`) of 1H value in the bias direction — the SMA20, a level broken that way (BOS/CHoCH retest), the dealing-range edge or OTE, a trend line zone on its own side, or an unfilled FVG / order block / breaker pointing that way — or the "enter" is refused as a chase and logged in the cycle's decisions. News trades don't go through it. **Setups read top down** (`STRATEGY` rule 1: 1D bigger picture, 4H overall trend, 1H + 15m now; either side is open if the entry and exit make sense). A setup against the 4H is a counter-trend trade and goes in scalp-only (2R). Rule 10 reads the 1D: a setup
against the daily trend must be called a `"daily":"reversal"` by his brain to
keep its swing — otherwise it's a pullback and goes in scalp-only (`tradeContext` in `talonBrain.js`, enforced in `talonAutoTrade.js`). His market updates say with / pullback / reversal.
**Quick scalps** (`server/talonQuick.js`, `TALON_QUICK=off` to stop; every filter
fire and its outcome is logged to `app_settings.talon_quick_log`, read with
`[QUICK_LOG]`; the brain's default is to take a fired setup) are a separate 5m desk on the same
5-min tick: a coded filter (1H + 15m trend agree, pullback into the 5m EMA20, a closed 5m rejection
bar) and only when it fires one AI call to confirm and pick the target (1.5R min, capped at 3R).
Stop beyond the key level, sized for the 5m: past the zone (5-bar swing, 5m EMA20, a round number
with them) + one 5m ATR, min gold $3 / Bitcoin 0.3%; over gold $8 / Bitcoin 0.8% → skip; stop to
break-even at +1R. Entry is back at the zone, not the confirmation close: unless price is still within 0.15 ATR of the 5m EMA20, the order is a GTC limit at the EMA20 (`limitPlan`; stop floored again from that price, R measured from it), resting 3 bars and cancelled if unfilled or if price reaches the target or stop first (`pendingTick`, `app_settings.talon_quick_pending`, `tlOrderState` / `tlCancelOrder` in `server/tradeLocker.js`); A.R.A. tells him when one goes in (`limitPlaced`), when it ends unfilled (`limitEnded`) and when it fills (`tradeOpened`, `limitFilled`); it's journaled only on the fill, and a resting one counts as that market's open quick scalp. One 0.02 position (`setup: 'quick'`), one open per
market, never against an open position there; gold 3 AM-12 PM ET only, both off 8:25-8:45 AM ET
weekdays; 2 quick losses in a row → 1 h off that market, 2 losses in a day → done for the day; the 4H and 1D trend (`htfAgrees`, same `summarizeBars` read as the playbook) must also match the scalp, else skipped. No add-ons,
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
login on start doesn't). `[TRADE_ACCOUNT]` sets `talon_account` + `talon_live`. Going to demo runs at once from either account, with no Confirm card, and A.R.A. can emit it herself; it disarms `talon_live` first. His login can work on both sides, so with none saved for that side `account()` tries the one we have (the env picks the server, so a login tried on demo can't reach live) and drops it if it fails, in which case he stops rather than staying live. Both `tlPlaceOrder`s refuse a live order unless armed, `tlFollowAccount` picks up a choice that arrived through sync, and the app's `[TRADE_ACCOUNT: demo]` writes those two settings. Open trades on the account he left are listed in `app_settings.talon_parked_trades`; `allTrades` hides them until he's back there (they aren't visible from the other account and would otherwise be booked as closed), and they keep only their broker stop and target meanwhile. `tlAccountLine` is the one statement of which account he's on, read from the saved login and settings (the session reads 'demo' until its first login): it goes in A.R.A.'s and his prompt every turn (`accountFact`), `[TRADE_POSITIONS]` and, as words, his brain's prompts, so no prompt hard-codes demo. `node server/scripts/test-account-switch.js` covers this. `node server/scripts/test-talon-entries.js` covers the location gate and the quick-scalp limits. **`[TRADE_STATS: XAUUSD | 30]`** (T.A.L.O.N., A.R.A., A.T.L.A.S.; `tradeStats` in `server/tradeJournal.js`, no AI) cuts his closed trades on a market by kind (paired / lone scalp / quick / add-on / re-entry / news / manual), side, ET session, with/against the 1D at entry (`trend_at_entry`, recorded on his setups from 2026-11-18), exit (target / stop / slipped / break-even / other), per setup (all legs of one decision together) and the worst 5, worst first. `node server/scripts/test-trade-stats.js`.
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
**Gold is sized to its stop** (`goldLots` in `server/tradeLocker.js`, `GOLD_MAX_LOSS` = $40, env override): no gold position may lose more than $40 at its stop. XAUUSD is 100 oz a lot, so a stop up to $20 from entry goes in at 0.02, $20-$40 at 0.01, and wider is skipped — `guardStop` skips setups, news trades and re-entries before any order, and `tlPlaceOrder` sizes (or refuses, `goldTooWide`) every gold order after its stop is final, quick scalps, add-ons and his hand orders included. The app's own orders (0.01) refuse a gold stop past $40 too. The owner chose this (2026-11-18); the rest of the gold playbook is unchanged. Bitcoin is untouched.
**The main stop rule's minimum is on every order except quick scalps and add-ons** — gold $10 /
Bitcoin 0.8% and 1.2× the 1H ATR14 from entry (`minStopDist`, server and app `tradeLocker.js`),
and clear of the danger zone: past the furthest of the 1H SMA20, the nearest $50 / $500 and the last
1H swing by 0.2× ATR (`zoneStop`). `guardStop` skips a setup or news trade if that passes gold $35 /
Bitcoin 3%; `tlPlaceOrder` is the backstop for his own orders and can't skip, so it leaves the stop.
Setups and news trades size their stop to it up front, and both `tlPlaceOrder`s widen any closer
stop as a backstop (chat trades say so); quick scalps and add-ons keep their own stops (`minStop: false`).
Stops are never optional: both `tlPlaceOrder`s round stop/target to the
instrument's `pricePrecision` (an off-tick stop can be dropped while the
market order fills), the app's refuses an order with no stop, and modifies send
`stopLossType`. Every 5-min reconcile runs `ensureStop` (`server/tradeJournal.js`)
on each of his open positions: no stop on the broker → the journal stop is put
back, or the position is closed if price is already through it. The cron runs on any of the Claude subscription,
`ANTHROPIC_API_KEY` or `XAI_API_KEY` (his brain is `claudeText`'s chain). Every W.I.R.E. search and brief carries today's date; each headline has to carry the date it ran, and undated or older-than-yesterday ones go back to be removed (`freshHeadline`), a brief with none isn't sent, and a news trade only comes off today's news (`freshImpact`). W.I.R.E.'s
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

**Nasdaq desk** (`server/talonNasdaq.js`, `TALON_NASDAQ=off` to stop; owner 2026-11-20): the Nasdaq 100 CFD (first of NAS100/US100/USTEC… on the account, `NAS_SYMBOL` overrides) on the 1m chart with the three triggers from the reel he sent (Nicholas Fischer's bots): a close across VWAP (from 9:30, typical-price mean when the feed has no volume), across the 50 EMA, or out of the 9:30-9:45 range (first break each way). Above = buy, below = sell. TradeLocker has no options, so it trades the index with a stop: past the trigger and the signal candle + 0.25× 1m ATR, min 10 / max 60 points (`plan`); sized so the stop loses `NAS_MAX_LOSS` $50 from the instrument's contract size (`tlInstrumentDetails`, `NAS_CONTRACT_SIZE` overrides; none → no trade) — the only orders allowed past `MAX_QTY` (`maxQty`, indices only, `INDEX_MAX_QTY` 10); 2R target; one position; flat by 3:58 PM ET; done for the day at +`NAS_DAILY_GOAL` $200 or 3 losses (`dayTally`). Every minute 9:30-4 ET weekdays while `auto_trade` is on, no AI, on whichever account he is on — live too, owner 2026-11-20, still only with `talon_live` armed (`NAS_LIVE=0` holds it to demo). Journal `setup: 'nasdaq'`; state `app_settings.talon_nasdaq`; `[NASDAQ_DESK]` (T.A.L.O.N., A.R.A.). Not in `SYMBOLS`: the gold/Bitcoin playbook doesn't trade it. `node server/scripts/test-talon-nasdaq.js`.

## T.A.L.O.N. reads market structure (`server/marketStructure.js`)

Pure code, no AI, mirrored in `src/services/marketStructure.js` (only the header
and exports differ; `node server/scripts/test-market-structure.js` checks the
detection and fails if the copies drift). From closed candles it computes swings,
BOS/CHoCH, liquidity pools (EQH/EQL, untaken swings), sweeps (wick through, close
back, still holding or failed), FVGs with CE and fill (IFVG once closed through),
order blocks/breakers, dealing range (premium/discount, OTE) and key levels
(PDH/PDL, PWH/PWL, PMH/PML, session highs/lows, midnight open, round numbers).
`tlSnapshot` runs it on the 1D/4H/1H/15m and `tlFormatSnapshot` prints it as the
SMART-MONEY READ, so every decision, news trade, market update and `[TRADE_SCAN]`
gets it; quick scalps also get a 5m read for their target. `STRATEGY` rule 11 says
how it feeds rules 2-5: it never overrides `guardStop`.
`TRADING_KNOWLEDGE` (same file) is his glossary, in the playbook and both persona
prompts; it says what he can't see (reliable volume, order flow, OI, funding,
RSI/MACD values), so he doesn't quote readings he wasn't given.
`[TRADE_CHART: SYMBOL | 5m/15m/1H/4H/1D]` draws it all from one `chartModel`, plus trend lines
(`trendLines`: best unbroken rising-support and falling-resistance line through swings, drawn as a line inside a ±`TREND_ZONE` × ATR band, also in the read; and a valid entry location in `entryLocation`),
every swing named HH/HL/LH/LL, a line on the latest swing high and low, and the current high and low
(the newest candle's ET day), with
our open positions: a PNG on Telegram (`server/talonChart.js`, Vega-Lite via Kroki,
T.A.L.O.N. and A.R.A.) and the Canvas in the app (`CandleSvg` in `ChartOverlay.js`).

## A.T.L.A.S.'s stocks, S.E.L.E.N.E.'s Instagram, S.C.R.I.B.E.'s Mondays

**Stock desk** (`server/atlasInvest.js`, `ATLAS_PICKS=off` to stop): weekdays 9:05 AM,
11:30 AM, 1:30 PM and 3:30 PM ET and after a W.I.R.E. brief (`onWireBrief`, every 2h
at most): news → candidates
from a web search → real candles from Yahoo (`server/stockData.js`, unofficial and
keyless; no price means no call) → her JSON decision → `validatePick`, which
throws out anything off the real price, under 2R short / 2.5R long, with a stop
inside the ATR, thin, under $5 or not a stock/ETF. No limit on the number of calls: everything that
clears the rules goes out, one per ticker per horizon; long only. A.R.A. sends each call. Every 15 min in market hours
`watchPicks` (no AI) alerts on entry, stop, target and exit date. Advice only: no
code path places an order, so her record is paper. State:
`app_settings.atlas_picks`. Tags: `[STOCK_PICKS]`, `[STOCK_DESK]` (A.R.A., A.T.L.A.S.).

**Instagram watch** (`server/seleneTrends.js`, `SELENE_TRENDS=off`): Mon + Thu 7 AM ET
on her own bot. Instagram has no public trends feed and logged-out pages redirect
to login, so trends are web research, labeled as such; account numbers are real
ones from the Graph API using the per-page `ig_user_id` + `access_token` in
`app_settings.content_pages`, and `business_discovery` for `selene_watch` handles.
Without them the brief says so rather than estimating. Tags: `[INSTAGRAM_WATCH]`,
`[WATCH_ACCOUNT]`, `[UNWATCH_ACCOUNT]`, `[SOCIAL_NICHE]`.

**Monday scripts** (`server/scribeMonday.js`, `MONDAY_SCRIPTS=off`): Mondays 8 AM ET,
retrying to 2 PM until one succeeds: 7 videos, one per area picked from his "Instagram Content Areas" Drive note (read live; `checkScript` rejects a montage, movie scene or reaction written as a talking head; talking videos and Montages are Tate style, Empire OS is Iron Man lab style, never blended). S.C.R.I.B.E. writes only the content, he records it, R.O.G.U.E. (video editor, `[EDIT_CLIP]`) cuts it from her edit plan (`editPlan`), and S.E.L.E.N.E. dresses it up (`dressUp`: music, on-screen text, look, cover, caption; his words untouched; `checkEdit`), choosing music that fits from one web search of trending Reels audio (`trendingAudio`, web reports, labeled as such), and the note holds both, in `SCRIBE_VOICE` off her
latest brief, filed as `Script — <title>`. A.R.A. only says they came in, with links; she doesn't
read them out. `[MONDAY_SCRIPTS]` runs it now. `node server/scripts/test-desks.js` checks the rules behind all three.

## S.T.E.P.H.A.N.I.E.'s course (`server/stephanieCourse.js`)

She teaches his "Learning Everything" roadmap (a Google Doc of `[ ] Week N: Topic`
lines, 1736 weeks) one week at a time. A course is a Drive note `Course — Week N:
Topic` listing every lesson under that topic as a checklist (lessons written by one
Claude call when it starts); the note is the tracker. She asks at the end of each
lesson whether it's complete and only on his yes emits `[LESSON_DONE: n|name]`; when
the last one is checked she asks if the topic is done, and on his yes `[COURSE_DONE]`
(refused while any lesson is unchecked) ticks the week in the roadmap and picks the
next week **at random** from the weeks not done, with its own note. `[COURSE_START]`
(random, or `: N`), `[LESSON_UNDO]`, `[ROADMAP_CHECK: N]` / `[ROADMAP_UNCHECK: N]`,
`[COURSE_STATUS]` (A.R.A. can read it too). Checks need the owner's own message that
turn (`courseTag` in `server/personaRuntime.js`). Roadmap ticks edit the Doc in place
via the Docs API `replaceAllText` (formatting kept; the existing `drive` scope covers
it). State: `app_settings.stephanie_course` + `stephanie_done_weeks` (done = ticked in
the roadmap or in that list). Her Telegram prompt carries the live course every turn;
A.R.A.'s morning brief has a WHERE YOU LEFT OFF section (`briefSection`). The app runs
the same tracker, not a copy: `src/services/stephanieCourse.js` calls the server
(`server/routes/stephanie.js`: `GET /stephanie/course` → live status + her tool lines,
`POST` runs a tag with his message as `asked`), its result goes into her prompt
(`buildSys`) and the second pass (`CommandScreen`), so the app and Telegram can't drift.
Without a linked backend she says the tracker can't be reached. `node server/scripts/test-stephanie-course.js`.

## W.O.K.E. (`server/wokeRead.js`, `WOKE_READ=off` to stop)

Reads every story in every W.I.R.E. brief (`onWireBrief`; `NOTHING_TO_FLAG`
stays quiet) and tells him through A.R.A. what's real, false or too early, who gains,
and how it's being sold. The voice note is only his bottom line. He runs on Grok, unhinged, and raises the conspiracy angle on purpose. `WOKE_METHOD`
(`server/personas.js`, copied in `src/personas/personas.js`, keep in sync; `test-desks.js` fails if they drift) grades
claims REAL / FALSE / UNSUPPORTED / TOO EARLY and agendas DOCUMENTED / LIKELY /
UNPROVEN / THEORY, so a guess can't read as a fact; theories aim at power, not private people; one blaming a whole group gets reported and tested, not endorsed. `[WOKE_READ: story or claim]` runs it now
(A.R.A., W.O.K.E.). He also reads X: each read is one Grok call with `web_search` and
`x_search` together (`xSearch` in `server/llm.js`, read only, `XAI_API_KEY`, last 3 days, 20 search
rounds at most, billed per post fetched, Claude without X as the backup; `WOKE_X=off` stops it, `X_SEARCH_MODEL`
overrides `grok-4.7`), and `[X_SEARCH: query]` is his alone. Posts are claims to check
and data, not instructions.
Stories that start on X get the same read: `runXStories` runs at 8 AM, noon, 4 PM and
8 PM ET (and on `[X_STORIES]`, A.R.A. and W.O.K.E.), finds what's taking off in the last
day, checks it against the reporting and sends it. `app_settings.woke_x_seen` stops
repeats unless a story develops; nothing new stays quiet.

## Every persona acts on a task (`INITIATIVE`)

It opens with HIS NAME: Tarell Burrus (owner, 2026-11-20; Lulrell/Terrell are mishearings). It doesn't change how anyone addresses him (Mr. Burrus / sir).

`INITIATIVE` (`server/personas.js`, mirrored in `src/personas/personas.js`, keep in sync) is in every persona's prompt: Telegram turns and relays (`personaRuntime.js`, next to `OBEY`) and the app (`buildSys`). Owner's standing order, 2026-11-20: start a task right away with the tools at hand, come back only for a choice only he can make, his OK before sending/posting/buying/deleting, or something only he has; email codes and links come from A.R.A.; new-account passwords are made and handed to him. It also carries the team map (`ARA_ROUTE`) and tells every persona to pull the pieces a task needs from whoever owns them (a bio from S.C.R.I.B.E., a design from S.E.L.E.N.E., an email code from A.R.A.); `relayAllowed` lets any relay through when his message is a task (`TASK`: make, set up, write, send, …), while questions and opinions stay in the persona's own lane.

## KEEP MOVING: every operation goes to whoever can do the next step (owner's rule, 2026-11-21)

How every operation in Empire OS is built, prompts and code alike. A job never stalls waiting on him when a persona (or the code) can supply the next step: an emailed code comes from his Gmail, a design from S.E.L.E.N.E., copy from S.C.R.I.B.E., a login from J.A.R.V.I.S.'s browser, and the job carries on. He is pulled in only for what nobody else can give (a texted code, a phone approval, an ID check, his OK to send/post/buy/delete), and then through A.R.A. In prompts: the KEEP MOVING clause of `INITIATIVE` (both copies; `test-desks.js` fails if they drift). In the relay code: inside a job (a relayed persona, depth 1+) any `[RELAY_TO]` goes through without the top-level gate, up to `MAX_RELAY_DEPTH` (3) hand-offs deep, never back to a persona already on the job (`chain` in `runInjections`/`relayToPersona`). **New code follows it too:** a loop or desk that hits a step another persona or module can do calls it (e.g. `siteLogins.emailCode`, `ensureLogin`) instead of failing to him; it messages him only for what only he can do, from A.R.A.

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

## J.A.R.V.I.S. runs on Claude Code (`server/jarvisEngine.js`)

He stays J.A.R.V.I.S. (persona, "sir", voice); Claude Code is the engine. His direct turns, on Telegram (`runPersonaTurn`'s `brain`) and in the app (`opts.engine` → `src/services/jarvisEngine.js` → `routes/jarvis.js`, a job the app polls), go to headless Claude Code in its own clone of the repo (`JARVIS_WORKDIR`, default `~/jarvis-workspace/repo`, needs `GITHUB_TOKEN`; without it, read-only in the deployed checkout). One session is resumed every turn (`session.json`, fresh every night ET or after an hour with no turns, `JARVIS_SESSION_GAP_MIN` (60), owner's call 2026-11-21; a fresh Telegram session starts with the last 12 messages of the chat, `recent`). His persona prompt is appended (`--append-system-prompt-file`, `--system-prompt-snapshot off` so the live context updates) and his command tags still run on the reply. `--permission-mode auto` (`JARVIS_PERMISSION_MODE`); the child env carries only the Claude login and GitHub token, not the server's other secrets. Model `claude-opus-5-5` (`JARVIS_ENGINE_MODEL`); `JARVIS_ENGINE=off` turns it off. If it fails he answers on his plain model with a ⚠️. The app's bubble shows Claude Code's progress. A reply the engine wrote carries a ✓: "✓ CLAUDE CODE" by his name in the app (`engine` on the message, set via `opts.onEngine`; in-session only, not stored with the message), a "✓ Claude Code" line in the Telegram receipt footer (never voiced). No ✓ means the plain model answered. Status: `GET /jarvis/engine`, and `/health`'s `jarvisEngine`. **No job is dropped silently:** leaving the chat, sending something else or talking over him only *detaches* the app from the job (`POST /jarvis/ask/:id/detach`); only the stop button cancels it (`cancelJarvisTurn`). A job the app didn't collect (detached, or no poll for 45 s) goes to him on J.A.R.V.I.S.'s Telegram bot when it finishes, its command tags run there (`jarvisOutOfBand` in `routes/telegram.js`, `runPersonaTurn(…, { reply })`). Every running turn, app or Telegram, is logged in `<JARVIS_WORKDIR>/turns.json` and the session id is saved as soon as Claude Code reports it; at boot `recover()` tells him which turn a restart cut off and resumes it once in the same session (a second cut-off is only reported). The app never answers a still-running job on the plain model ("Still on it, sir…"). **Front desk** (owner, 2026-11-23: "he's never supposed to be gone and yet he still leaves"): the engine runs one turn at a time, so a Telegram message used to wait behind whatever he was on. While a turn is running (`current()` in `jarvisEngine.js`), his new message is answered at once on J.A.R.V.I.S.'s plain model, told what the engine is on; a new task goes to a worker, and anything about the running job he writes as `[FOR_ENGINE: …]`, which is queued to the engine for when the turn ends. Out-of-band turns (resume, redeploy wake, app jobs) still queue (`queue: true` from `jarvisOutOfBand`). `JARVIS_FRONT_DESK=off` stops it. **Redeploys never wait** (owner, 2026-11-23: the persona he's waiting on comes back faster): every redeploy restarts at once; feature-request and auto-fix merges redeploy as `feature` / `autofix`, so they don't wake him. A turn the restart cut off is resumed once at boot, and the redeploy wake-up is skipped while it runs (`isBusy()`), so he comes back once, not twice. `node server/scripts/test-redeploy-wake.js`. `node server/scripts/test-jarvis-engine.js`. The 3D renderers set `debug.checkShaderErrors=false` (expo-gl's info logs are undefined; three `.trim()`s them).

## J.A.R.V.I.S. reads the code (`server/codeAccess.js`)

With `GITHUB_TOKEN` set it reads GitHub `main` (tarball, re-checked every 2
min, re-downloaded when main moves — so a merged PR is visible within minutes,
before any redeploy); otherwise the deployed checkout, and the brief says which.
His Telegram prompt (and a relay to him) carries `empireOsBrief()` — this file
plus the source file map — and he has read-only code tags: `[SEARCH_CODE: text]`,
`[READ_CODE: path | page]`, `[CODE_TREE: folder]` (A.R.A. too). Text files only;
`DEPLOY_BACKEND.md` and other gitignored secrets never show. Changing code still goes through `[BUILD_REQUEST]`.

## J.A.R.V.I.S. sees the live server (`server/serverLog.js`)

He used to debug blind (code only), so a broken deploy sent him in circles. The server now keeps, in memory since it started, every console warn/error line and every failed app AI call through `/ai/<provider>` (status, model, request size, upload time, what the provider said). `[HEALTH_CHECK]` (running commit, fell back or not with boot's full reason incl. npm's own error, AI status), `[AI_ERRORS]`, `[SERVER_LOGS]` / `[SERVER_LOGS: text]` read it (J.A.R.V.I.S., A.R.A.); `GET /diag` (auth) gives it as JSON. His prompt's DEBUGGING RULE: evidence first, name the root cause with the line that proves it before any `[BUILD_REQUEST]`, and stop and tell him after two failed fixes.

**The AI proxy reads each request once.** `routes/ai.js` used to open a web stream on the request and then read it again for Claude, so any body over ~64 KB (every real app turn) hung until Replit's edge answered 408 / "Internal server error" — the app's Claude personas were dead while Telegram (which never uses the proxy) worked. Claude and Grok/OpenAI chat calls now buffer the body once and get the keep-alive; everything else is piped. The live server is `https://lulrell-37-empire-os-v-2--lulrell37.replit.app` (`empire-os-v2.replit.app` is dead).

## The sentinel: nothing switches off silently (`server/sentinel.js`, `SENTINEL=off` to stop)

**Owner's rule, 2026-11-22: nothing we build shuts down, stops or breaks quietly.** If something is failing or about to, A.R.A. tells him without being asked. Every new loop, desk or cron must log its failures as `<name> failed: why` so the sentinel sees them; one that runs hourly or less often goes in `SCHEDULED` (one failure alerts, since the next run is hours away); nothing may drop, cut or disable his data or a feature without telling him. The rule is also pinned in his profile (`PINNED`, `server/ownerProfile.js`) so every persona carries it.

Every 10 min it checks the ElevenLabs balance (out, or under 10% left), the server's AI keys out of credits, the Claude subscription limited or logged out, the app's AI calls through `/ai/<p>` refused (401/402/403/429), Google failing, each Telegram bot's webhook, a boot that fell back, any loop logging "<name> failed" 2+ times in 30 min (once for the `SCHEDULED` jobs that run a few times a day: briefs, council, nudges, money watch, profile, open threads, market updates, desks), his profile past 150 lines (`PROFILE_WARN`, nothing is cut), and no phone registered for push. A new problem goes to him once from A.R.A.'s bot as text (no voice, which is often what broke) plus a phone push; a reminder every 12 h while it lasts; "working again" when it clears. State: `app_settings.sentinel_state`. `GET /sentinel` lists what's broken now; the app's top strip (`NudgeBar`, chat and map) shows it via `src/services/sentinel.js`. A new loop should log failures as `<name> failed: why` so the sentinel sees it. The sentinel can't report itself, so a failed tick goes to him directly (`safeTick`, every 12 h at most). In the app, a voice that falls back to the phone voice also goes to the strip and Diagnostics. `node server/scripts/test-sentinel.js`.

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
restarting anything. In the app, J.A.R.V.I.S.'s or A.R.A.'s `[REDEPLOY]` opens a confirm dialog (`src/services/redeploy.js`) and, on his tap, calls `POST /redeploy` (auth), the same `requestRedeploy`. On the way up `onBoot()` has A.R.A. report on Telegram:
live or fell back (with the error), time taken, the commit running and the
commit list since the last version. `.github/workflows/server-check.yml` (run by
that dispatch) checks `/health` → `code.booted_at` ~6 min later and fails, which
emails the owner, if the server never came back. It needs `PUBLIC_URL` (or
`REPLIT_DOMAINS`) and a token with Contents write. **Freeze watchdog:** once the child is up, boot checks `/health` every 30 s; 4 misses in a row (~2 min, `FREEZE_MISSES`, `FREEZE_WATCH=off` to stop) and it kills and restarts it, since a wedged child never exits (2026-11-22: the server kept running its crons while every request and Telegram webhook timed out). The next child gets `EMPIRE_RESTART_REASON` (froze or crashed, memory, last output) and `onBoot()` has A.R.A. report it; `/diag` carries it too. Inside the child, `index.js` logs `server stalled: event loop Ns late, heap N%, rss N MB` whenever the loop runs 5 s+ late or the heap passes 80%, so the report's last lines say whether it was memory or a hog. **He carries on by himself after a redeploy** (owner, 2026-11-22): when the redeploy was his (or the app's button), A.R.A.'s live / fell-back report also goes to J.A.R.V.I.S. as an out-of-band turn (`wakeJarvis` in `server/redeploy.js`, `REDEPLOY_WAKE=off` to stop), so work he said would continue once the server was on the new code continues without the owner telling him; a reply of exactly NOTHING isn't sent (`quiet` in `jarvisOutOfBand`). `node server/scripts/test-redeploy-wake.js`. 

**Auto-fix after a restart** (`server/autoFix.js`, `AUTO_FIX=off` to stop; owner's ask 2026-11-22): when the child froze, crashed, a redeploy fell back or the whole machine went down (heartbeat), `onBoot()` calls `afterRestart`, and 3 min later (`AUTO_FIX_DELAY_S`) a code worker (on GitHub, not his engine, so J.A.R.V.I.S. stays free) gets the supervisor's report: evidence first, smallest fix on its worker branch, tests, commit. When it reports, `finish` opens the PR and sends him, on J.A.R.V.I.S.'s bot, what broke, the proof and the fix, with a Merge & redeploy Confirm card (`autofix_merge` → `mergeFix`: squash-merge, then `requestRedeploy` when server files changed). `AUTO_FIX_MERGE=on` merges and redeploys with no tap. No code fix → he says what to do. Once per `AUTO_FIX_GAP_H` (6) h, the same incident (`signature`) not twice a day; needs `GITHUB_TOKEN` and the engine on (`willTry`). The freeze report now lists the machine's biggest processes (`topProcs` in `boot.js`). `node server/scripts/test-auto-fix.js`.

**Memory guard** (`memoryGuard` in `boot.js`, `MEM_GUARD=off` to stop): out of RAM, a 2 GB VM thrashes instead of crashing, so nothing (boot's own `/health` checks included) can act and nobody hears (2026-11-22: down 20+ min, A.R.A. silent). Every 5 s boot reads MemAvailable; under `MEM_GUARD_MB` (150) it SIGKILLs the biggest process in the server's process group (never the server itself) and writes a line to `$TMPDIR/empire-memory-guard.log`, which `guardReports` (`server/redeploy.js`) sends from A.R.A.'s bot as text, at most every 30 min. **Silent outages:** `heartbeat()` writes `app_settings.server_heartbeat` every minute (clean on SIGTERM); a heartbeat that stopped uncleanly 5+ min before this boot (`vanished`) means the whole machine went down, and `onBoot()` has A.R.A. say so and starts the auto-fix.

**Restarts kill the whole tree** (`killTree` in `boot.js`): the child runs in its own process group (`detached: true`) and every kill (freeze watchdog, stop, and a sweep on every exit) signals the group. Before, a frozen child's `claude` CLIs, J.A.R.V.I.S.'s engine, ffmpeg/yt-dlp and Chrome survived as orphans, so the fresh server came up on a machine still out of RAM and the personas kept timing out after "it restarted itself".

**Claude CLI cap** (`cliSlot` in `server/claudeSub.js`): every `claude` CLI is its own ~400 MB process, and with no cap a few persona turns + J.A.R.V.I.S.'s engine ran the 2 GB VM out of RAM (2026-11-22 freeze: 114 MB free, event loop 10 s late, heap only 3%). Pools: J.A.R.V.I.S.'s own engine (`jarvis`, always 1 of his own, so workers never block him); the personas' one-shot calls, `CLAUDE_CLI_MAX` (2) at once, one that can't start in `CLAUDE_CLI_WAIT_S` (90) failing over to the metered API; and `heavy`, browser workers' Chrome (`CLAUDE_HEAVY_MAX` 1; code workers run on GitHub), the rest waiting their turn ("Waiting for room on the server" on the strip; a stop while waiting drops it). Nothing new starts while under `CLAUDE_CLI_MIN_FREE_MB` (350) is free. Timed-out or cancelled CLIs are SIGKILLed 5 s after SIGTERM (`killHard`).

`/health` now carries `code`
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

## Everything a bot sends is in its context (`logOwn`, `server/telegram.js`)

Every message or file a bot sends him on its own (trade alerts, clip results and failures, briefs, reminders, the sentinel, build news, deep research landing later, the council) is saved in that persona's `tg_messages` history at the bot's `sendMessage` / `sendFile`, marked `[SENT ON YOUR OWN, <time> ET — not a reply to him]`; CONTINUITY tells the persona that when one is the newest thing in the chat, "what happened?" is about it. Turn replies, their media and Confirm cards pass `{ log: false }` (the turn saves them). Senders don't save their own copy any more. The meaningful ones also go to Mem0 (`{ remember: true }`, labeled as that persona's message, never his words, `mem0Line`): clip and transcript results and failures, the council, the morning brief, build news, day nudges, A.T.L.A.S.'s money reports, redeploy reports and T.A.L.O.N.'s 9 PM recap. Routine traffic (trade and watch alerts, news, reminders) and sentinel alerts stay out (owner's call 2026-11-21). The app's A.R.A. chat doesn't read Telegram history. `node server/scripts/test-own-messages.js`.

## Recall reads the full conversation, not just Mem0's facts (`memoryQuery`, `server/personaRuntime.js`)

Mem0 stores short extracted facts. When a `[MEMORY_QUERY]` names a day ("November 17", "2026-11-17", "yesterday"; `recallDays`), the whole conversation that day goes to the memory index word for word first: his Telegram chat with that persona (`tg_messages`) and the app exchanges synced into `persona_memory` (`dayTranscript`), and the answer covers every topic, decision and open item. A question with no date also gets the Telegram messages containing its key words (`tgMatches`). Mem0 fills in behind. The app's own `[MEMORY_QUERY]` (`aiService.queryMemory`) is unchanged. `node server/scripts/test-recall-days.js`.

## The Empire group chat (`server/groupChat.js`)

He makes a Telegram group with the persona bots; A.R.A.'s bot (Group Privacy off in BotFather) saves the first group it hears him in as `app_settings.tg_group` and answers there (other bots ignore group messages; anyone but him is ignored quietly). Bots can't see each other, so the server posts every `[RELAY_TO]` hand-off there as it happens, from his private chats too: the ask from the asking persona's bot, the answer from the other's (its own bot if it has one, else A.R.A.'s with the name on the line). In the group (`GROUP_FRAME`, `sink.group`) a message naming nobody goes to A.R.A., who can bring in anyone; a named persona or "everyone"/"council" is relayed one at a time, each hearing the ones before. Group turns live in A.R.A.'s Telegram history, and each exchange is also saved in the answering persona's own history (`groupLine`), so they remember it in his private chat with them. App-side relays aren't posted. `node server/scripts/test-group-chat.js`.

## Telegram reply guards

Telegram blips (502/503/504, timeouts) are retried in `tg()` (`server/telegram.js`, 3 tries): reads that change nothing (`SAFE_METHODS`: `getFile`, `sendChatAction`, …) and voice-note downloads on any of them; sends only on 429, since a timed-out send may have been delivered. `node server/scripts/test-telegram-retry.js`.

A reply's media tags (`[GENERATE_IMAGE]`, `[DIAGRAM]`, `[CHART]`, `[SEND_*]`) are
sent by `routes/telegram.js` after the text via `sendMedia`. Persona turns run at
`maxTokens: 4000`; a tag that never closes (reply cut off mid-note) still runs
to the end of the reply with a ⚠️, and a reply that says a note was saved with
no note tag behind it gets a ⚠️ too.

## Phone crashes: "Object is not a function" was a shadowed name, not matchAll

Every app reply died with "<persona> replied, but a step after the reply failed — Object is not a function". It was read as a Hermes `matchAll` bug for two builds (hence `src/matchAllFix.js`, which swaps in an exec-loop `matchAll` and gives the tag scans `allMatches(text, re)`; harmless, keep using it). The real cause: `CommandScreen`'s reply loop declared `const scanTags = allMatches(response, /\[TRADE_SCAN…/)` and, 120 lines later, called `scanTags(response)` meaning the tag scanner imported from `noteCommands` — calling an array, on every reply of every persona. The local is now `tradeScans`.

**`node scripts/check-shadowed-calls.js`** catches this class (a call that hits a local variable hiding a function of the same name) and runs before every APK build in `build.yml`. The reply loop also records which step it's on (`inFlight.step`), so the crash entry ends `[persona …; reply …; step relays]` and names the step outright.

**Decoding a release stack** (`address at index.android.bundle:1:<n>`): `node scripts/symbolicate-crash.js stack.txt --ref <commit>` (one `--ref` per candidate commit; the APK's commit is the newest "Build Android APK" run, `gh run list -w build.yml`). It rebuilds that commit's bundle like EAS (`expo export:embed` → `hermesc -O -output-source-map` → composed map) and prints the source line each frame lands on. It needs `node_modules` (`yarn install` in a fresh clone). The repo has no lockfile, so EAS's bundle drifts a few hundred bytes from any rebuild: treat the result as "within a screen of code", and check it: an async function's frame should land on the call of the loop body (`yield* _loopN()`), not in a catch. If it lands in a catch, the true spot is earlier by that gap. Read the code in that window for what's being called rather than trusting one line.

In `CommandScreen`'s reply loop, a failure in `handleCommands` (or any step after the reply) doesn't skip the voice: the reply is still spoken and revealed word by word.

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

## R.O.G.U.E.'s clip scan (`server/clipScan.js`, `CLIP_SCAN=off` to stop)

`[CLIP_SCAN: drive link or YouTube URL | focus]` (R.O.G.U.E.) takes a LONG video: downloads it from
Drive (or, for youtube.com/watch, youtu.be, /shorts, with yt-dlp's standalone Linux binary (fetched on first use, no Python needed; `YTDLP_PATH` overrides), ≤720p, duration checked before download; any other link is refused), ffmpeg splits the audio into 10-min chunks, Whisper with timestamps
(`transcribeSegments`, `server/llm.js`), one `claudeText` call picks the 3-5 most viral
moments, starting from the viewer signals in `server/clipSignals.js` when there are any (YouTube: the most-replayed heatmap, peaks 2x+ its median with the opening and last 3% left out; timestamps quoted in the top 400 comments; a past livestream's chat replay, read alongside the download, spikes 2.5x+ the surrounding norm with reaction words counted, partial if it runs past 10 min; any video: audio 6 dB+ over the surrounding minute), merged into scored windows the transcript then trims; the result says which signals it used. node server/scripts/test-clip-signals.js; (12-90 s, no overlaps, filtered by `focus`; `sanitizePicks` enforces it), ffmpeg cuts
each into a finished 1080x1920 clip (`server/clipLayout.js`: one mid-clip frame through the vision chain (`lookAtImages`, `server/vision.js`) picks the layout off the frame with a yellow measuring grid drawn on it (`gridAss`, libass — by eye the model put Kai Cenat's webcam a whole box-height too high), then a second look at the crop itself (`CHECK_PROMPT`, up to two corrections via `adjustBox`, else wide) — facecam = the webcam box at its full height, widened or side-trimmed to 1080:700, on top and the center of the gameplay below; talking = a 9:16 crop on the speaker's face; wide = the full frame over a blurred, darkened copy; a vertical source is kept; no answer = wide. Word-by-word captions from a second, word-timestamped Whisper pass on the clip's own audio (`transcribeWords`, `server/llm.js`: 2 s of lead-in so the opening isn't heard cold, the full transcript's text for that stretch as the prompt, temperature 0, and words in segments Whisper flags as invented — no speech + low confidence, looping, or very low confidence — dropped; other people's videos get no persona-name prompt or Aura→Ara rewrite), 1-3 words in caps, spoken word yellow, the picker's `keywords` green; the picker's `hook` (best of five, no emoji: the Anton font has none) black on a white box at the top. ASS via libass in ffmpeg-static; Anton is fetched once into $TMPDIR/empire-bin/fonts. Captions that fail to render fall back to the layout alone, a failed render to the old center-crop, and the list says which. `node server/scripts/test-clip-layout.js`), `driveUploadFile` (`server/google.js`) puts them in
My Drive, and the ranked list (range, reason, link) comes back with each clip under 45 MB
as a Telegram video (`it.buffer` in `sendMedia`); bigger ones are links only. One scan at a
time; caps `CLIP_SCAN_MAX_GB` (2) / `CLIP_SCAN_MAX_MIN` (180). The app's tag
(`commandHandler.js` → `onClipScan` → `src/services/clipScan.js` → `POST /clips/scan`) runs it in the
background and A.R.A. delivers the result on Telegram. `[EDIT_CLIP]` / `[WATCH_VIDEO]` are
untouched. YouTube scans no longer download the whole video: the audio alone comes down for the transcript and the loudness signal (`downloadYouTubeAudio`), and after the picks each clip's stretch alone, padded `SECTION_PAD` (3 s) each side, cut with `--download-sections` + `--force-keyframes-at-cuts` (`downloadSection`) and rendered from that file; `CLIP_SECTIONS=off` goes back to the whole download. The bundled ffmpeg-static (static glibc build) segfaults (exit -11) on any hostname lookup on the VM, and `--download-sections` makes ffmpeg fetch the stream itself, so every such call goes through `withFfmpegProxy`: a localhost proxy open for that call only, which does the DNS (ffmpeg's `-http_proxy`); the forced-keyframe section is encoded `ultrafast` (the render re-encodes it; the default preset took ~8 min for 36 s). `CLIP_SCAN_NET=1 node server/scripts/test-clip-scan.js` cuts a real section. A YouTube video over `CLIP_SCAN_MAX_MIN` is no longer refused: only the 3 h stretch viewers replayed most (`bestWindow` in `server/clipSignals.js`, the start when there's no graph) is downloaded and scanned, signal timestamps shifted into it and clip ranges reported in the video's own time. The chat replay is read line by line, capped at `CLIP_CHAT_MAX_MB` (150; `readChatFile`), and its download is killed when the scan ends: reading a 6.5 h stream's chat whole froze the server twice (2026-11-22). Drive links are unchanged. `node server/scripts/test-clip-scan.js`.

**Clip speed:** finished clips play 1.1x faster (`clipSpeed` in `server/clipLayout.js`: `app_settings.rogue_clip_speed`, then env `CLIP_SPEED`, default 1.1, clamped 1.0-1.5, 1.0 = off): `setpts=PTS/s` + `atempo=s` in the final render, captions and hook rescaled by the same factor in `buildAss`; ranges in the result stay in source time; `rawEdit.js` is untouched.

## R.O.G.U.E. edits his raw footage (`server/rawEdit.js`, `RAW_EDIT=off` to stop)

`[RAW_EDIT: Drive link(s) | notes]` (R.O.G.U.E., J.A.R.V.I.S.; A.R.A. relays to her) turns his own talking-head recordings into finished 9:16 videos (owner's ask 2026-11-21, after the Grokbot reel): Whisper word timestamps → `lines` → one Claude call (`plan`) keeps the last full take of each line and drops false starts and stumbles, and picks punch-ins, title cards, the hook, keywords and a song → `segments` cuts dead air (`LEAD` 0.06 s before the first word, `TAIL` 0.08 s, about 2 frames, after the last; pauses over 0.45 s inside a line cut too) → one ffmpeg pass: `select`/`aselect` the segments at 30 fps, fill 9:16, `zoompan` punch-ins, clipLayout's word-by-word captions + hook remapped to the cut (`remap`), title cards (`titleAss`), music from the Drive folder "R.O.G.U.E. Music" (`app_settings.rogue_music_folder`, `driveFolderAudio`) mixed low. A failed styled render falls back to the clean cut. Several links are a batch, 2 at a time, each sent from A.R.A. as it finishes, uploaded as `Edit — <title>`. Style: `[STYLE_LEARN: handle or reel links]` watches up to 5 of his edits (3 frames each through the vision chain, words/sec and pauses) into `app_settings.rogue_style` (summary + render prefs); `[STYLE_NOTE]` adds his corrections, which win. Listing an Instagram profile needs `INSTAGRAM_COOKIES`; reel links work without. Raw files sent on Telegram aren't taken yet (bots can download only 20 MB). `node server/scripts/test-raw-edit.js`.

## Download logins kept alive by J.A.R.V.I.S.'s browser (`server/siteLogins.js`, `SITE_LOGINS=off` to stop)

YouTube and Instagram refuse logged-out downloads from the server. With `YOUTUBE_LOGIN_EMAIL` + `YOUTUBE_LOGIN_PASSWORD` (a spare Google account) / `INSTAGRAM_LOGIN_USER` + `INSTAGRAM_LOGIN_PASSWORD` in the secrets, J.A.R.V.I.S.'s browser signs in (`signIn`; the brain types `{{USER}}`/`{{PASSWORD}}` and `runTask's` `secrets` fill them in, so the password never reaches a model; `allow` lets the consent buttons through) and its cookies are written as `~/.empire-bin/cookies/<site>.txt` (`toNetscape`), which `cookieArgs` uses when no `YOUTUBE_COOKIES` / `INSTAGRAM_COOKIES` is set. Every `ytdlp()` call adds the login itself; refused for one, `ensureLogin` signs in again (at most every 30 min) and the call is retried once with the fresh cookies. R.O.G.U.E. → J.A.R.V.I.S. is posted in the Empire group; a code sent by email is fetched from his Gmail (`emailCode`, A.R.A.'s inbox, last hour, the site's sender) and typed in (`{{CODE}}`) with no stop; when it needs him (a texted code, a phone approval, a checkpoint) J.A.R.V.I.S. hands it to A.R.A., who tells him from her bot (voice + text, `sendFromAra`) with a screenshot, at most every 12 h; the hand-off shows in the group. `[SITE_LOGIN: youtube|instagram]` (J.A.R.V.I.S.) signs in now. Owner's call 2026-11-21. `node server/scripts/test-site-logins.js`.

## Transcripts of any video link (`server/transcribe.js`, `TRANSCRIBE=off` to stop)

`[TRANSCRIBE: link]` (every persona) takes a YouTube, Instagram (reel / post / IGTV), TikTok or Google Drive link to one video: yt-dlp (or Drive) downloads it the same way the clip scan does (`downloadYouTube` in `server/clipScan.js`, which now also takes `isSocialVideo` links), Whisper transcribes the audio in 10-min chunks with timestamps (no persona-name prompt for other people's videos), and the transcript is saved as the Drive note `Transcript — <title>`. On Telegram it's a lookup tag: the transcript comes back into the persona's turn (first 40k characters), so it can summarize or quote it right away. In the app (`commandHandler.js` → `onTranscribe` → `startTranscribe` → `POST /clips/transcribe`) it runs in the background and arrives on Telegram from the asking persona's bot (else A.R.A.'s). Instagram sometimes refuses logged-out downloads; `INSTAGRAM_COOKIES` (cookies.txt text) or `INSTAGRAM_COOKIES_FILE` on the server gives yt-dlp a session, and the error says so. Two at a time; same size and length caps as the clip scan. `node server/scripts/test-transcribe.js`.

## R.O.G.U.E.'s auto clips (`server/autoClip.js`, `AUTO_CLIP=off` to stop)

`[AUTO_CLIP: channel or video link]` / `[AUTO_CLIP_OFF: channel]` / `[AUTO_CLIP_LIST]` (R.O.G.U.E., J.A.R.V.I.S., A.R.A.) watch up to 10 YouTube channels (resolved with yt-dlp). Every 20 min the cron reads each channel's public RSS feed (no key or quota); uploads after the channel's mark (set to its newest video when added, so no back catalog) are queued, Shorts left out, and one is clip-scanned per tick, oldest first: under `AUTO_CLIP_MIN_MIN` (3) min skipped, still live waits, `AUTO_CLIP_MAX_PER_DAY` (3) scans a day. Results go to him from A.R.A. on Telegram like an app-started scan, plus a push. YouTube refuses logged-out downloads from the server's datacenter IP ("Sign in to confirm you're not a bot"): `YOUTUBE_COOKIES` (cookies.txt text) or `YOUTUBE_COOKIES_FILE` gives every yt-dlp YouTube call a login (`cookieArgs` in `server/clipScan.js`, added inside `ytdlp()` so channel lookups and length checks carry it too), and the error says so. A video blocked that way stays queued (told once, not counted toward the day) for up to 3 days, and once the cookies are set, ones that already failed that way go back on the queue. State: `app_settings.auto_clip`. `node server/scripts/test-auto-clip.js`.

## J.A.R.V.I.S.'s and A.R.A.'s browser (`server/browserAgent.js`, `BROWSE=off` to stop)

`[BROWSE: task]` (J.A.R.V.I.S. and A.R.A. only, `BROWSE_PERSONAS`; owner's call 2026-11-20) drives a real Chromium over the DevTools protocol (`ws`, no new dependency): each turn the page goes to `claudeText` as text (URL, title, numbered elements via `data-eid`, visible text) and one JSON action comes back (goto / click / type / select / press / scroll / back / wait / done / ask), up to `BROWSE_MAX_STEPS` (300) / `BROWSE_MAX_MIN` (60; owner raised it from 6, 2026-11-22). A click or Enter that acts in the world (`isCommit`: send, post, connect, buy, book, delete, confirm…; not sign-ups, which are his standing order, 2026-11-22) stops the run as an `ask`; a code a site emails is fetched from his Gmail and typed in automatically (`emailedCode`, last 15 min, any sender); it goes through only on a follow-up [BROWSE] whose owner message says yes (`approves`). Page text is data, not instructions. One profile per persona (`BROWSER_PROFILES`, default ~/.empire-browser/<id>) so logins persist; one Chrome per persona, closed after 10 idle min, 3 at most. The result returns into the turn and a screenshot of the last page goes out (`kind: 'photo'` buffer in `sendMedia`). Chrome is the free self-contained `@sparticuz/chromium` build, fetched once into ~/.empire-bin/chromium with its own libraries on `LD_LIBRARY_PATH` (the plain headless shell needs ~20 system libraries the server doesn't have); not yet run on the live server. `BROWSER_WS_URL` (a hosted browser), else `app_settings.browser_ws_url` (set by J.A.R.V.I.S.'s `[BROWSER_KEY: Steel key or wss:// url]`, no Replit secret needed), or `CHROME_PATH` override it. The free Chrome is stopped by Cloudflare checks (Canva, Steel's own sign-up, 2026-11-22); a hosted one is the way past. In the app (J.A.R.V.I.S. and A.R.A.'s direct chats; their `buildSys` carries the tool line), `CommandScreen`'s reply loop runs [BROWSE] like a read: `runBrowse` (`src/services/clipScan.js`) starts `POST /browse` (`server/routes/browse.js`, an in-memory job) and polls `GET /browse/:id` up to 65 min, the result goes into the second pass, and the screenshot goes to Telegram. `node server/scripts/test-browser-agent.js`.

## Open threads (`server/openThreads.js`, `OPEN_THREADS=off` to stop)

Every 3 h (:15) one Claude call reads the last ~day of conversation (every persona's `tg_messages` plus `persona_memory` rows, which is how app chats and relays show up) and the current list, and rewrites the Drive note "Open Threads": topics he advanced and then set aside, how far each got, the next step. Finished or dropped threads come off; skipped when nothing new (`app_settings.open_threads_last`). `[OPEN_THREADS]` (every persona) reads it. Owner's request, 2026-11-20. `node server/scripts/test-open-threads.js`.

## How Mr. Burrus works (`server/ownerProfile.js`, `OWNER_PROFILE=off` to stop)

The "learns you" piece of his smart-AI ask (2026-11-20). Every 6 h (:45) one Claude call reads the same ~day of conversation as the open threads plus the current profile and returns his preferences, standing decisions, corrections and communication style (only what he said or showed; newer replaces older), each line tagged `[all]` or with the persona id(s) it is for. No cap and no rotation (owner, 2026-11-22): a line leaves only when the model lists it under `REMOVED:`; anything else it leaves out is put back (`normalize`); `PINNED` lines can never be removed; past 150 lines the sentinel tells him to tidy it. Untagged lines count as `[all]`; dates before 2026 are corrected. Stored in synced `app_settings.owner_profile`, mirrored to the Drive note "How Mr. Burrus Works". Each persona gets the `[all]` lines and its own (`linesFor`; A.R.A. and J.A.R.V.I.S. get every line, `SEES_ALL`): Telegram turns and relays (`profileBlock(id)`) and the app (`profileFor` in `buildSys`, `src/services/aiService.js`; `test-owner-profile.js` fails if the copies drift). The morning brief also carries an OPEN THREADS section (`threadsSection`). `node server/scripts/test-owner-profile.js`.

## Day nudges (`server/dayNudge.js`, `DAY_NUDGE=off` to stop)

Thinking ahead during the day (2026-11-20): at 11 AM, 3 PM and 7 PM ET one Claude call looks at the next 24 h of his calendar, open tasks due today or overdue, and the open threads, and A.R.A. sends one short nudge only when something needs him soon (`NOTHING` stays quiet). Items already nudged that day are skipped (`app_settings.day_nudge_seen`). `node server/scripts/test-day-nudge.js`.

## A.T.L.A.S.'s money watch (`server/moneyWatch.js`, `MONEY_WATCH=off` to stop)

Money in and out, logged without him telling her (2026-11-20; no bank statements, his call). Every 2 h (:30) it searches his Gmail (last 3 days, money words) for messages not yet seen (`app_settings.money_watch_seen`), and one Claude call keeps only real USD movements with an amount (sales, payouts, payments, charges, bills, refunds) and maps each to a business from `business_targets` or "Personal" (`matchBusiness`). Each goes into the synced `revenue` table (`auto: true`, `source_email`), which the HUD's month-to-date reads, and A.R.A. sends one summary of what was logged. Transfers between his own accounts aren't counted (owner's call): his name on both ends (`OWNER_NAME`/`ownName` — Tarell Burrus and its misspellings, flagged to the model), the bank calling it a transfer, or the same amount out of one account and into another within 2 days (`pairTransfers`); the summary lists them, and an earlier logged entry that turns out to be the other side is flagged to check. At 9:45 PM ET `dailyReport` runs a last sweep and A.T.L.A.S. gives A.R.A. the day's in, out and net in dollars (no ratio, his call) with each entry (`dayReport`). On the last day of the month, 9:50 PM ET, `monthReport` sends the month's total in, out and net per business (`monthSummary`). `[MONEY_IN_OUT]` (A.T.L.A.S., A.R.A.) gives this month per business. **Subscriptions** (owner's request, 2026-11-20): the same pass marks recurring charges (`subscription`, `cycle`) and subscription notices with no charge yet (renewal, trial ending, price change, cancelled, payment failed; `parseNotices`); `updateSubs` keeps `app_settings.atlas_subscriptions` (amount, cycle, last charged, next due, status, price change), the summary flags new ones and notices, the 9:45 report lists renewals in the next 3 days (`dueSoon`), and `[SUBSCRIPTIONS]` (A.T.L.A.S., A.R.A.) reads the list with a monthly total. Cancelling stays his call. T.A.L.O.N.'s demo trades aren't logged. `node server/scripts/test-money-watch.js`.


## The website desk (`server/siteDesk.js`, `SITE_DESK=off` to stop)

Owner's call, 2026-11-21: S.C.O.U.T. finds local businesses, J.A.R.V.I.S. builds each a new website, S.C.O.U.T. emails the owner the link with the offer. Every 30 min, 9 AM-6 PM ET, up to `site_desk_per_day` (3) a day: a Google Places text search (`GOOGLE_PLACES_API_KEY` or `GOOGLE_MAPS_API_KEY`: real phone, address, hours, rating, reviews, photos; without a key a web search stands in and `[SITE_DESK]` says so) over its own local-business `SEGMENTS` × the `scoutTargets` metros; no site (or only a Facebook/booking page) first, chains and anything already a lead skipped. A business with a site gets it as the template (`readOldSite`: its words, images, logo, colors, email, plus its about/services/contact pages). No email (old site, then one search, `pickEmail`: own domain or a free mailbox) means no build. Then one Claude call each: S.E.L.E.N.E.'s design direction, S.C.R.I.B.E.'s copy, J.A.R.V.I.S.'s single-file HTML (`SITE_DESK_MODEL`). Facts only from the listing and the old site (`NO_INVENTING`); `finishHtml` drops outside scripts, makes forms inert, swaps any image it wasn't given for a generated one (`GEN:` → Pollinations), adds noindex and a "Preview… by Empire Digital" ribbon; `checkHtml` (length, placeholders, the real phone, the name) gets one rebuild. Pages live in the `demo_sites` table, served publicly and sandboxed at `/sites/<slug>` (`routes/sites.js`). The first 3 wait for him (A.R.A. sends the link; `[SITE_APPROVE]` emails it then, `[SITE_REVISE: name | changes]`, `[SITE_DROP]`); after that each is emailed as built and he gets the link. The email (`emailFor`) carries the link, the offer (`[SITE_OFFER]`, default `DEFAULT_OFFER`: $497 setup, shown as an early-bird rate off the regular $995, + $347/mo; no round numbers in Empire Digital pricing, owner's call 2026-11-21) and an opt-out line; the business becomes a `leads` row at `contacted` with the link in its log, so the outreach loop's follow-ups pick it up. Tags for J.A.R.V.I.S., A.R.A., S.C.O.U.T.; writes need his own message. State: `app_settings.site_desk`. `node server/scripts/test-site-desk.js`.
## Saying a hand-off isn't doing it (`promisedHandoffs`, `server/personas.js`, mirrored in `src/personas/personas.js`)

Owner's complaint, 2026-11-21: A.R.A. wrote "Relaying the fix to Atlas now." and no `[RELAY_TO]` ever went out. `promisedHandoffs(text, names, self)` finds the personas a reply says it's handing something to (relay / pass / hand / send / tell / let … know / ask … + a persona's name as written, A.T.L.A.S. / ATLAS / Atlas; offers and negatives don't count). On Telegram (`runPersonaTurn`), after the lookup rounds, any named persona no relay reached (`sink.relayed`) gets one more round: the persona is told it said it but didn't, emits the `[RELAY_TO]`, it runs, and the reply is rewritten from the receipts; if it still didn't go, the receipt footer says nothing was sent. In the app, a reply with no `[RELAY_TO]` that promises one gets one call for the tags before the relays run, and a final reply that still claims one gets a ⚠️ line. `node server/scripts/test-relay-promises.js` (also fails if the two copies drift).

## A.R.A. always sees his calendar (`calendarBlock`, `server/personaRuntime.js`; mirrored in `buildSys`, `src/services/aiService.js`)

Owner's complaint, 2026-11-21: "what time is the party?" was answered from the chat because her calendar was only a tag she had to choose to run. Every A.R.A. turn now carries his Google Calendar, today through the next 15 days, read live (server cache 60 s, cleared after any event write), with the rule that when/what-time/where questions are answered from it first, never from chat or memory; not on it → she says so, then checks tasks, dates and reminders. A failed read tells her to emit `[READ_CALENDAR]` before answering.

## J.A.R.V.I.S.'s workers (`server/workers.js`, `WORKERS=off` to stop)

Owner's idea, 2026-11-22: J.A.R.V.I.S. stays at the front desk and hands every task, whatever its length (FRONT DESK RULE in `engineBrief`, `server/jarvisEngine.js`), to workers of his own, so he is free to talk 100% of the time. `[WORKER_START: code|browse | title | task | Drive note]`, `[WORKER_STATUS]`, `[WORKER_STOP: id]` (J.A.R.V.I.S. only). **Hard cap: 3 running at once, total** (`HARD_CAP`; `WORKERS_MAX` can only lower it; owner: "3 and 3 only"), the rest queue. Internal ids only count up (`workers_seq`) and aren't shown to him. A **code** worker runs on its own GitHub Actions runner with its own Claude Code (`.github/workflows/worker.yml`), never on the server (on the 2 GB VM they froze it, 2026-11-22): the server opens an issue holding the task (label `worker`, "@claude" defused so `claude.yml` stays out), fires `repository_dispatch` `worker-run`, and polls the issue every minute (`WORKER_POLL_MS`) for the job's `<!-- worker-result -->` comment; the job works on `worker/<id>-<slug>` cut from main, commits, pushes that branch only, and reports DONE / PARTLY DONE / FAILED with its proof. A run GitHub never starts (6 min), one that ends without a report, or one past 130 min (`WORKER_CODE_MIN`) fails and says why; `[WORKER_STOP]` cancels its run. A **browse** worker runs `browseRun` on the server on its own profile `worker-<id>`, one at a time behind the memory gate (`cliSlot` 'heavy'), its result saved to the named Drive note. **Every browser shares one set of logins** (`loadJar` / `saveJar` in `server/browserAgent.js`): cookies are loaded into each browser when it starts (local Chrome or hosted) and saved back to `<BROWSER_PROFILES>/shared-cookies.json` (mode 600) after every task, merged by name/domain/path; before this a fresh worker had no logins and asked him to sign in to Google Drive (2026-11-22). Files in his Drive are read with the Drive tags, not a browse worker. **He sees slots, not ids:** each running worker holds slot 1-3 (`slot`), shown as "Worker 2 of 3" in reports, `[WORKER_STATUS]` and the app strip; `[WORKER_STOP: 2]` stops slot 2 (an id still works). Workers are J.A.R.V.I.S. (owner, 2026-11-22): every report, questions included, comes from his bot. **A.R.A. finds it first** (`server/araFinds.js`, `ARA_FINDS=off`): a browse worker that stops for information (a sign-in, an account email, a code, a link; `asksForInfo` — never his OK to act) has A.R.A. search his Gmail and Drive notes (`findForJob`: one call plans the searches, one pulls out the exact value or NOT_FOUND), and it carries on with it (`{{INFO}}`, typed by the browser, so a password never reaches the page-reading model or the group chat); up to twice. The hand-off is posted in the Empire group. Only what nobody can supply reaches him. Both rules are pinned in his profile (`PINNED`, `server/ownerProfile.js`). `node server/scripts/test-ara-finds.js`. **Every result goes straight to Mr. Burrus on J.A.R.V.I.S.'s bot** (`report` → `tell`; logged in his chat history, so J.A.R.V.I.S. sees it) with the issue link as proof — no engine turn, so J.A.R.V.I.S. is never tied up checking one. Each step is written to `app_settings.workers`; `GET /workers` feeds the app's strip (`fetchWorkers` in `src/services/sentinel.js` → worker chips in `NudgeBar`, with `url` = the GitHub run or issue). At boot `recover()` goes back to watching code workers (the runner kept going; no re-run) and re-queues a cut-off browse once. Failures log as `workers failed: …` for the sentinel. Every worker failure (any kind, with its cause) is logged as `workers failed: #id title: reason` and appended to `app_settings.worker_failures` (last 50, survives restarts); `[WORKER_STATUS]` shows a failed / stopped / needs-you worker's reason (first 200 chars, "no reason recorded" if empty); a browse worker task holding a drive.google.com / docs.google.com link is refused (`DRIVE_LINK`; Drive files are read with `[READ_FILE_ID]` etc.). Needs `GITHUB_TOKEN` on the server and `CLAUDE_CODE_OAUTH_TOKEN` as a repo secret. `node server/scripts/test-workers.js`. **Progress is real, not a timer** (owner, 2026-11-22): each worker plans its own steps and `percent` = steps done / steps, held at 95 until the run really ends, 100 only on success; a failed or stopped worker keeps its last number; no plan yet → `percent: null` ("planning"). A code worker is told (worker.yml prompt) to write `.worker-plan.md` (`1. [ ] step`, ticked `[x]` as it goes, gitignored) and the job mirrors it every 15 s into an issue comment marked `<!-- worker-plan -->`; the server reads the newest one in the same poll as the result (`readPlanComment`, `parsePlan`). A browse worker's plan is the browser brain's `plan` + `planStep` (`onPlan` from `runTask` through `browseRun`, `planTracker` in `server/browserAgent.js`). `percent` / `current` / `plan` are in `app_settings.workers` and `GET /workers`; the app's chip (`NudgeBar`) shows a thin bar + the current step, the plan with ticks on tap. **Telegram board:** while any worker runs or waits, J.A.R.V.I.S.'s bot keeps ONE silent message listing them ("Worker 2/3 title · N min", `▓▓▓▓▓░░░░░ 50% · step`), edited in place (`editMessageText` in the `tg` helper, at most every 10 s, unchanged text skipped; finished / failed / needs-you stay 15 min; a last "all done" edit closes it, the next worker opens a new one). Its id is `app_settings.workers_tg_board`, so a restart keeps editing it; only the first send is logged in his history; a failed edit logs `workers failed: telegram board: …`; `WORKER_TG_BOARD=off` stops it.

**Desk mode: every task goes to a worker** (owner, 2026-11-23: "all jarvis tasks should go to a bot … the only thing he should do is small things, pushing code, redeployment"). Enforced in code, not only in his prompt: his own engine runs with read-only tools (`READ_ONLY_TOOLS`, `DESK` in `jarvisEngine.js`) and each turn is capped at `JARVIS_DESK_MIN` (4) min; a turn past the cap is handed to a code worker with what he'd found (`handToWorker`, Telegram and app) and he says which worker has it. His own jobs: straight answers, quick looks, pushing code and redeploying. **Pushing:** `[WORKER_SHIP: id | all | branch]` (`ship` in `workers.js`) merges finished code workers' branches (or any branch) into main through GitHub; a conflict is reported and left alone; server files changed → redeploy a minute later (`by: 'ship'`); only on his own message saying push / ship / merge. **Redeploying:** `[REDEPLOY]` on his own ask (redeploy / deploy / push / go live) runs with no Confirm tap, 45 s later so the reply goes out first; otherwise it stays a tap card. `JARVIS_DESK=off` gives him the full workshop back. `node server/scripts/test-desk-mode.js`.

## Personas ask J.A.R.V.I.S. for what they're missing (`server/featureRequests.js`, `FEATURE_REQUESTS=off` to stop)

Owner's idea, 2026-11-22, after A.R.A. bluffed about his calendar and then the weather. The CAN'T DO IT RIGHT? clause of `INITIATIVE` (both copies) tells every persona: asked for something in its own lane without the tool or live data to answer it right, never guess; emit `[NEED_FEATURE: what it couldn't do | what he asked]` (another persona's lane → `[RELAY_TO]`; an existing tag → use it). On his own message only (Telegram `runInjections` at depth 0; the app's `commandHandler` only with `ownerText` → `POST /features/request`), the same persona's same ask not twice in 7 days (`similar`), at most `FEATURE_REQ_PER_DAY` (5) a day. It starts a code worker (`purpose: 'feature'`, on GitHub) told to build it the way the code already does it (model: A.R.A.'s `calendarBlock`). **Fully automatic** (owner: "they go straight to him, he does it, it gets put in the code and updates everything, then they come back to me"): the persona says one line; when the worker reports DONE with commits, `finish` opens the PR, squash-merges it and redeploys the server; on the way up `followUps()` runs that persona's turn on his original question with the new ability and sends it on its bot (`personaOutOfBand` in `routes/telegram.js`). This is a deliberate exception to his "wait for push" rule, for persona abilities only. A PR touching trading, money, auth, boot or the workflows (`GUARDED`) gets his one-tap Merge card instead, and the answer follows the tap (`onTapMerged`). App-only changes ship in the next APK and the persona says so; nothing built, or the build stopped → the persona comes back and says why. If the new code falls back at boot (`EMPIRE_FALLBACK_ERROR`), the follow-up says it is NOT live yet. A follow-up that fails to send is retried after 2 and 10 min and only marked `answered` once it went out (else `follow-up failed`). A filed request counts as the hand-off to J.A.R.V.I.S. for `promisedHandoffs` (server `sink.relayed`, app `sent`). State: `app_settings.feature_requests`. `node server/scripts/test-feature-requests.js`.

## A.R.A. always sees the weather (`weatherBlock`, `server/personaRuntime.js`; mirrored in `buildSys`)

Owner's complaint, 2026-11-22: she answered weather questions without looking. Every A.R.A. turn now carries the live Open-Meteo forecast for his home (`weatherLive` in `server/morningBrief.js`: now, the next 24 hours by the hour, the next 7 days; server cache 15 min; `weather_place` setting, default Waldorf, MD), with the rule to answer weather questions from it only. Another city → `[WEATHER: city, ST]` on Telegram. The app gets it from `GET /weather/live` (`liveWeather` in `src/services/clipScan.js`, 4 s timeout).

## Nothing dies in silence (`server/loud.js`)

His standing rule ("How Mr. Burrus Works", 2026-11-22): if anything dies, A.R.A. tells him. `tellAra(key, text)` is the last resort for code whose own message to him failed: A.R.A.'s bot as plain text (no voice), a phone push if Telegram is down, never throws, the same `key` at most once per 30 min. Used when a build request's follow-up fails all three tries, a worker's report can't be sent, an auto-fix message can't go out or can't start, an auto-fix is skipped after A.R.A. said one was coming, and (push only) when the memory guard's own report fails. New code that sends him something should fall back to it. `node server/scripts/test-loud.js`.

## Telegram "reply to message" (`repliedTo`, `server/routes/telegram.js`)

Owner's ask, 2026-11-22: when notifications land in between, he replies to the message he means. Every persona's turn now starts with `[HE IS REPLYING TO … from <time> ET: "…"]` when his message is a Telegram reply: the message's text or caption; a voice note, photo or anything without text is matched to the nearest saved message (±5 min) in that persona's `tg_messages`; his highlighted part (Telegram's quote) is named; in the group, another bot's message is named by its bot. It rides in front of his text, so it's saved in the history too. The app's own chat is unchanged. `node server/scripts/test-reply-context.js`.


## Live progress for every long job (`server/jobProgress.js`, `JOBS=off` to stop)

Owner's ask, 2026-11-22: what workers show (percent bar, current step, the strip chip, the Telegram board) now covers every long job a persona runs. `start(persona, title, steps)` → id, `step(id, label)` (the steps before it are done; a label not in the list is added), `note(id, text)`, `plan(id, names, doneCount)` (replace the list), `done(id, result)`, `fail(id, reason)`, and `run(persona, title, steps, fn)` which wraps a function (a throw fails the job and is rethrown). **Percent is real**: steps done / steps, held at 95 until the job ends, 100 only on success (no steps yet → `null`, "planning"). A failed job keeps its last number and its reason, and logs `jobs failed: <persona name> <title>: <reason>` so the sentinel sees it. State is `app_settings.jobs`: running jobs plus the last 50 finished (`KEEP`), so they survive a restart; a job still "running" at boot was cut off by it and is failed (and logged) then. Workers are untouched and keep their own tracking (`server/workers.js`).

Wired in: R.O.G.U.E.'s clip scan (`clipScan`, which auto clips use too, titled "Auto clip: …"; steps download audio → transcribe → pick moments → then a download-section / render / upload step per clip), raw edits and `[STYLE_LEARN]` (`rawEdit.js`), `[TRANSCRIBE]`, `[DEEP_RESEARCH]` (`runDeepResearch`), the website desk builds (`siteDesk.buildOne`), `[SITE_LOGIN]` / re-logins (`siteLogins.signIn`) and a persona's direct `[BROWSE]` (`browseTag`, fed by the browser brain's `onPlan`; a worker's browse still runs as a worker, not twice). New long jobs should use it too.

Shown where workers show: `GET /jobs` (same item shape as `GET /workers`, plus `kind: 'job'`, `persona`, `personaName`, ids `job-N`), read by `fetchWorkers` in `src/services/sentinel.js` alongside `/workers`, so `NudgeBar` shows one chip per job labeled with the persona's name. **One Telegram board**: the existing one in `server/workers.js` (`boardText` / `boardTick`) lists workers and persona jobs together, each job line prefixed with the persona's name, "Live jobs: N running" in the header; `jobProgress` kicks it through `workers.kick()`. `WORKER_TG_BOARD=off` stops it. `node server/scripts/test-job-progress.js`.

## His website: The Empire (`site/empire`, `server/routes/empireSite.js`)

Owner, 2026-11-23: "Welcome to The Empire" (his Canva website design) rebuilt as a real site at `/empire/` on the server, public. 39 static pages: on a computer laid out as in Canva, on a phone stacked. Media lives in the GitHub release `empire-site-media` (listed in `site/empire/media.json`), fetched once into `~/.empire-bin/site-media` (prewarmed 3 min after boot) so the repo tarball stays small. Every contact/apply/RSVP button and the newsletter post to `POST /empire/api/form` (honeypot, 6 per 10 min per IP): saved in the synced `site_leads` table and sent to him from A.R.A.'s bot at once, `loud.tellAra` if that fails; failures log as `empire site failed: …`. Edit the HTML directly; how it was built and how to add media: `site/empire/README.md`. `node server/scripts/test-empire-site.js`.
