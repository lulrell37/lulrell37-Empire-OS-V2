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
short; anything over `ARA_LONG_CHARS` (1200 characters, relay or her own reply) runs
longer (up to ~450 words) but is still her, never a report: the full `ARA_VOICE` +
`ARA_SCRIPT` always lead (the Claude backup gets the same system prompt), and `araLongHint`
only adds a short MUST-SAY list the code pulled out of the message (`mustSay`,
`server/scriptCoverage.js`: numbers, price levels, times, percents, market and persona names;
dates and list numbers skipped). **Coverage is checked in code** (`missingFrom`, no AI,
spoken forms count: "4,215", "4215", "forty-two fifteen", "four thousand two hundred
fifteen"): any fact missing from her script gets **one** Grok repair pass (script + missing
items, told to work them in without rewriting the rest); still missing after that, one short
line in her voice at the end says them. Never more than one repair call, and the whole
script pass is capped at `SCRIPT_BUDGET_MS` (80 s) so a voice note never hangs (then the
usual fallback). The morning brief's script (`spokenScript`) uses the full `ARA_VOICE` +
`ARA_SCRIPT` too, 450-600 words, every section kept. The Telegram text stays as the desk
wrote it. Long audio is voiced in sentence-split pieces
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

**A.R.A. never whispers** (owner, 2026-11-26: "the voice cues she has still has whisper, remove it"): `[whispers]` is gone from `ARA_SCRIPT` (both copies) and the morning brief's script, which now say never whisper; `noWhisper` (`server/araVoice.js`, mirrored in `src/services/voiceCues.js`) strips any whispering cue from her text right before her voice is made (`voiceNote`, her Grok voice, the app's `textToSpeech` and `grokVoiceUri`). Other personas keep the cue.

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
in (Groq first, OpenAI behind it, see Speech-to-text below); out is ElevenLabs for everyone, A.R.A. scripted by Grok first (`server/personaVoice.js`,
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

**T.A.L.O.N. trades gold (XAUUSD), Bitcoin (BTCUSD) and the Nasdaq 100 (NAS100) only** (Nasdaq added 2026-11-26), on a fixed
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
**Every market is sized to its stop** (`riskLots` in `server/tradeLocker.js`; `GOLD_MAX_LOSS` / `BTC_MAX_LOSS` / `NAS_MAX_LOSS`, $40 each; Bitcoin and Nasdaq added 2026-11-26, owner: "the same thing we did for gold to lose less"): no position may lose more than $40 at its stop. Bitcoin's and Nasdaq's $ per point come from the instrument's contract size (`tlContractSize`; Bitcoin falls back to 1, Nasdaq has no fallback, so no trade and it says so; `BTC_CONTRACT_SIZE` / `NAS_CONTRACT_SIZE` override). Bitcoin is 0.02 sized down like gold; Nasdaq is sized up to the $40 (up to `INDEX_MAX_QTY`). No gold position may lose more than $40 at its stop. XAUUSD is 100 oz a lot, so a stop up to $20 from entry goes in at 0.02, $20-$40 at 0.01, and wider is skipped — `guardStop` skips setups, news trades and re-entries before any order, and `tlPlaceOrder` sizes (or refuses, `goldTooWide`) every gold order after its stop is final, quick scalps, add-ons and his hand orders included. The app's own orders (0.01) refuse a gold stop past $40 too. The owner chose this (2026-11-18); the rest of the gold playbook is unchanged. Bitcoin is untouched.
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

**Nasdaq desk — retired 2026-11-26** (owner: "stop trading Nasdaq … put the same strategy we already use"; `TALON_NASDAQ=on` brings it back). Nasdaq now trades on the playbook: `SYMBOLS` has `NAS100` (whatever the account calls it, NAS100 / US100 / USTEC…, `tlInstrument` resolves it and `tlInstrumentsById` reports it as NAS100), fresh setups only 9:45 AM-3:30 PM ET weekdays (`nasHours`), stop floor 0.4%, ceiling 1.5%, round numbers every 100 points (`ZONE_ROUND` / `STOP_CEILING`, both `marketStructure.js` copies), `MAX_PAIRS` 1, no quick scalps. The old desk, for reference (`server/talonNasdaq.js`; owner 2026-11-20): the Nasdaq 100 CFD (first of NAS100/US100/USTEC… on the account, `NAS_SYMBOL` overrides) on the 1m chart with the three triggers from the reel he sent (Nicholas Fischer's bots): a close across VWAP (from 9:30, typical-price mean when the feed has no volume), across the 50 EMA, or out of the 9:30-9:45 range (first break each way). Above = buy, below = sell. TradeLocker has no options, so it trades the index with a stop: past the trigger and the signal candle + 0.25× 1m ATR, min 10 / max 60 points (`plan`); sized so the stop loses `NAS_MAX_LOSS` $50 from the instrument's contract size (`tlInstrumentDetails`, `NAS_CONTRACT_SIZE` overrides; none → no trade) — the only orders allowed past `MAX_QTY` (`maxQty`, indices only, `INDEX_MAX_QTY` 10); 2R target; one position; flat by 3:58 PM ET; done for the day at +`NAS_DAILY_GOAL` $200 or 3 losses (`dayTally`). Every minute 9:30-4 ET weekdays while `auto_trade` is on, no AI, on whichever account he is on — live too, owner 2026-11-20, still only with `talon_live` armed (`NAS_LIVE=0` holds it to demo). Journal `setup: 'nasdaq'`; state `app_settings.talon_nasdaq`; `[NASDAQ_DESK]` (T.A.L.O.N., A.R.A.). Not in `SYMBOLS`: the gold/Bitcoin playbook doesn't trade it. `node server/scripts/test-talon-nasdaq.js`.

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

## Breaking news as it happens, H.A.V.E.N.'s health read, A.R.A.'s updates, S.T.E.P.H.A.N.I.E.'s drill (owner, 2026-11-26)

**Breaking watch** (`breakingWatch` in `server/newsWire.js`, `BREAKING_WATCH=off`): a gunman in DC reached him hours late because W.I.R.E.'s only break detector, the headline poll, runs at most once per 2-hour slot (`POLL_EVERY_HOURS`) and only 6 AM-11 PM, so anything that broke just after a slot waited up to 2 h. The watch runs every `BREAKING_EVERY_MIN` (30) min around the clock on Claude only (a web research call, then one short call to judge it). Grok's live X search (`xSearch`, `days: 1`, 4 rounds) runs only when he asks about breaking news: `[BREAKING_NOW]` (A.R.A., W.I.R.E.; `breakingWatch({ onDemand: true })`, which answers even when there's nothing new). Owner, 2026-11-26: "I don't want Grok running that often, only use Grok if I ask about the breaking news". The watch finds and judges anything confirmed in the last hour (active shooter, attack, disaster, big DMV police / lockdown / Metro events, major government or world events, market shocks). A real one goes out at once from A.R.A. (`🚨 W.I.R.E. — BREAKING` + push), then the full brief follows led by it (`refreshNewsBrief({ breaking })`), which fans out to W.O.K.E., A.T.L.A.S. and H.A.V.E.N. like every brief. Midnight-6 AM only `severity: major` gets through. `app_settings.breaking_seen` stops repeats. Failures log `breaking watch failed: …`. The 2-hourly poll is unchanged.

**H.A.V.E.N. on the news** (`server/havenHealth.js`, `HAVEN_HEALTH=off`): every W.I.R.E. brief (`onWireBrief`) gets one Claude call as H.A.V.E.N. for what touches his or his family's health (outbreaks, recalls, food / drug / water safety, air quality, heat, DMV health risks, health policy or insurance that affects him). `NOTHING` stays quiet; otherwise her short take goes to him from A.R.A.'s bot as `🩺 H.A.V.E.N. → A.R.A.` and into both their memories. `app_settings.haven_health_seen` stops repeats.

**A.R.A.'s updates come from W.I.R.E.** (`newsBlock` in `server/personaRuntime.js`): every A.R.A. turn carries W.I.R.E.'s latest brief (2500 chars) with when it was written; asked for an update or the news, she answers from it, and when it's over an hour old she emits `[NEWS_NOW]` (A.R.A., W.I.R.E.: `refreshNewsBrief` now, the brief goes to him in full and comes back into her turn). Her `contextBlock` no longer repeats the short copy. Telegram only; the app's NEWS panel already reads `hud_state`.

**Multiplication drill** (`server/stephanieQuiz.js`, `STEPH_QUIZ=off`): every 30 min, 8 AM-10 PM ET, S.T.E.P.H.A.N.I.E.'s bot sends 5 multiplication questions, pure code (`makeQuiz`: 1-digit × 2-digit up to 2-digit × 2-digit, a step harder after a 5/5, easier after 2 or fewer). The set and its answer key are `app_settings.steph_quiz`; her prompt carries them every turn (`quizBlock`), she grades his reply with a trick for each miss and records `[QUIZ_SCORE: n]`. `[QUIZ_NOW]` / `[QUIZ_OFF]` / `[QUIZ_ON]` on his own message (`app_settings.steph_quiz_on`). **Unanswered sets** (owner, 2026-11-26: "she'd just remind me … then after a few attempts she goes to Ara and Ara tells me, but she should be angry"): while today's last set isn't graded, each turn re-sends that set as a reminder, firmer each time (`reminderText`), instead of a new one; after `REMIND_MAX` (3, `STEPH_QUIZ_REMINDERS`) the next turn hands it to A.R.A. (posted in the group as the hand-off), whose out-of-band turn tells him off, angry but not cruel, and lists the questions (fallback: `loud.tellAra`). Then quiet until he answers (`[QUIZ_SCORE]`); a new day starts fresh. Her prompt knows how many reminders went out, so she's glad when he's back. `node server/scripts/test-news-desks.js` covers all four.

## Every persona acts on a task (`INITIATIVE`)

It opens with HIS NAME: Tarell Burrus (owner, 2026-11-20; Lulrell/Terrell are mishearings). It doesn't change how anyone addresses him (Mr. Burrus / sir).

`INITIATIVE` (`server/personas.js`, mirrored in `src/personas/personas.js`, keep in sync) is in every persona's prompt: Telegram turns and relays (`personaRuntime.js`, next to `OBEY`) and the app (`buildSys`). Owner's standing order, 2026-11-20: start a task right away with the tools at hand, come back only for a choice only he can make, his OK before sending/posting/buying/deleting, or something only he has; email codes and links come from A.R.A.; new-account passwords are made and handed to him. It also carries the team map (`ARA_ROUTE`) and tells every persona to pull the pieces a task needs from whoever owns them (a bio from S.C.R.I.B.E., a design from S.E.L.E.N.E., an email code from A.R.A.); `relayAllowed` lets any relay through when his message is a task (`TASK`: make, set up, write, send, …), while questions and opinions stay in the persona's own lane.

## KEEP MOVING: every operation goes to whoever can do the next step (owner's rule, 2026-11-21)

How every operation in Empire OS is built, prompts and code alike. A job never stalls waiting on him when a persona (or the code) can supply the next step: an emailed code comes from his Gmail, a design from S.E.L.E.N.E., copy from S.C.R.I.B.E., a login from J.A.R.V.I.S.'s browser, and the job carries on. He is pulled in only for what nobody else can give (a texted code, a phone approval, an ID check, his OK to send/post/buy/delete), and then through A.R.A. In prompts: the KEEP MOVING clause of `INITIATIVE` (both copies; `test-desks.js` fails if they drift). In the relay code: inside a job (a relayed persona, depth 1+) any `[RELAY_TO]` goes through without the top-level gate, up to `MAX_RELAY_DEPTH` (3) hand-offs deep, never back to a persona already on the job (`chain` in `runInjections`/`relayToPersona`). **New code follows it too:** a loop or desk that hits a step another persona or module can do calls it (e.g. `siteLogins.emailCode`, `ensureLogin`) instead of failing to him; it messages him only for what only he can do, from A.R.A.

## The Empire works in unison: hand-offs go to the lane owner (owner's standing order, 2026-11-23)

When a topic touches another persona's lane, that persona does its part without him naming them, and each chains the next step (research → S.A.G.E., numbers/targets → A.T.L.A.S., copy → S.C.R.I.B.E., design → S.E.L.E.N.E., clips → R.O.G.U.E., code → J.A.R.V.I.S., …: `ARA_ROUTE`). **Gate:** `relayAllowed(userText, id, from, relayText)` (`server/personas.js`, mirrored in `src/personas/personas.js`, keep in sync; `test-relay-lanes.js` fails if `LANES` drifts) lets a relay through when it comes from A.R.A., or the target owns the lane of his words or of the relay's own text (`LANES`, keywords per persona), or he named the target / asked for a hand-off / gave a task as before. A message that touches no lane and names no one still stays in the persona's own lane (opinions, quick questions). **Limits unchanged:** `MAX_RELAY_DEPTH` (3), never back to a persona already on the job (`chain`), and anything that sends, posts, buys, deletes or trades still needs his OK. The THE EMPIRE block (`personaRuntime.js`, app `buildSys` in `aiService.js`) and `INITIATIVE` say this; the rule is pinned in `PINNED`.

**New ventures:** when he says he is starting a new business, channel or income stream, S.A.G.E. researches what it earns, hands it to A.T.L.A.S., and A.T.L.A.S. adds it with `[ADD_BUSINESS: name | monthly | weekly | note]` (server `personaTools.js`, app `commandHandler.js`; `SET_TARGET` only edits existing lines; `NEW_VENTURE` in `relayAllowed` lets those two relays through). A.R.A.'s calendar and email stay hers alone, and relays inside a job still skip the top-level gate.

**New-venture fixed order** (`server/venture.js`, `VENTURE=off` to stop; owner's standing order, 2026-11-23): whenever he says he wants to start anything (business, channel, product, project, idea) to any persona, usually A.R.A., code runs it in order before that persona answers (`ventureStep` in `runPersonaTurn`, his own direct message only, same message not twice in 10 min; `detectVenture`, `server/personas.js`, mirrored in `src/personas/personas.js`). 1) S.A.G.E. researches it (ends with `MONEY: yes|no`); 2) if money, A.T.L.A.S. gets her research and emits `[ADD_BUSINESS]` with monthly and weekly targets, checked against `business_targets` (one retry, else the result says it did not land); 3) lane owners run in parallel (`laneOwners`: S.E.L.E.N.E. brand, S.C.R.I.B.E. copy, A.I.S.H.A. legal, S.C.O.U.T. leads when it is money, plus any persona whose `LANES` match his words), each with the research and targets; 4) the combined `[NEW VENTURE RESULT]` rides into the asking persona's turn so it reports it. Its own bounded run: each step is a depth-1 relay (they may hand off two more, `MAX_RELAY_DEPTH` and `chain` unchanged), shown as a live job; a failed step logs `venture failed: …`. Sending, posting, buying, deleting and trading still need his OK. In INITIATIVE (both copies) and `PINNED`. App chat only has the prompt rule (the pipeline runs server-side, Telegram). `node server/scripts/test-venture.js`.

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

He makes a Telegram group with the persona bots; A.R.A.'s bot (Group Privacy off in BotFather) saves the first group it hears him in as `app_settings.tg_group` and answers there (other bots ignore group messages; anyone but him is ignored quietly). Bots can't see each other, so the server posts every `[RELAY_TO]` hand-off there as it happens, from his private chats too: the ask from the asking persona's bot, the answer from the other's (its own bot if it has one, else A.R.A.'s with the name on the line). In the group (`GROUP_FRAME`, `sink.group`) a message naming nobody goes to A.R.A., who can bring in anyone; a named persona or "everyone"/"council" is relayed one at a time, each hearing the ones before. Group turns live in A.R.A.'s Telegram history, and each exchange is also saved in the answering persona's own history (`groupLine`), so they remember it in his private chat with them. **Every line also comes as a voice note** (owner, 2026-11-23; `GROUP_VOICE=off` to stop): right after the text, from the same bot that posted it (its own, else A.R.A.'s), in that persona's own ElevenLabs voice (`voice` in `groupChat.js`, via `voiceNote` with `scripted: true` so another persona's words never get A.R.A.'s Grok script pass or her voice; `speakNames` applies). Own voice (the `voiceId` on each `ROSTER` entry in `server/personas.js`, which must equal the app's `elevenlabsVoiceId` in `src/personas/personas.js`; `test-group-chat.js` fails on any drift or a missing one, 2026-11-23): A.R.A., J.A.R.V.I.S., S.E.L.E.N.E., S.T.E.P.H.A.N.I.E., H.A.V.E.N., A.I.S.H.A., R.O.G.U.E., S.C.O.U.T., N.O.V.A., P.U.L.S.E., A.T.L.A.S., T.A.L.O.N., ABRAHAM, BATMAN, ANDREW. Only S.C.R.I.B.E., H.O.O.K., S.A.G.E., W.I.R.E. and W.O.K.E. have none in the app either, so they use one generic default (`GROUP_DEFAULT_VOICE`, else ElevenLabs stock Adam) until a voice id is added in both rosters. A line over 600 characters is voiced as its first sentences plus the sentences with numbers (`voiceText`, no AI call); the full text is always the message. ElevenLabs out of characters (the sentinel's `elevenlabs` finding) skips it and `voiceNote` falls back to OpenAI TTS. Notes go out in order, off the post's path; a failure never blocks the text and logs `group chat failed: voice …` for the sentinel. App-side relays aren't posted. `node server/scripts/test-group-chat.js`.

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

**Checkpoints (resume after a restart, owner 2026-11-23):** the scan works in `~/.empire-bin/clip-jobs/<video id>-<hash of link+focus>` (`CLIP_JOBS_DIR`), not a per-run temp folder. The downloaded audio/video (`state.json` source, trusted only if ffprobe-style `duration` reads ≥95% of the saved length), the transcript (`transcript.json`), the picks (after the video check) and each finished clip's upload line (the clip mp4 stays for Telegram) are saved as each finishes; a rerun (the boot resume in `jobProgress.recover`, or the same link sent again) skips every step whose output is there and valid. Success removes the directory; a failure keeps it; directories untouched for 2 days are pruned (`pruneJobDirs`, at every scan start). Raw edits keep their downloaded footage and word transcript the same way (`~/.empire-bin/raw-edit-jobs`, `RAW_EDIT_JOBS_DIR`); transcribe and deep research simply rerun. `node server/scripts/test-clip-scan.js` (resume skips a finished download and transcript).

**Funny first** (owner, 2026-11-22/23: other creators' clips weren't funny): comedy lives in reactions and timing, not transcript words, so laughter evidence drives the picks. Signals (`clipSignals.js`): chat laughter words (`LAUGH`: LMAO, KEKW, 💀, 😂, "im dead"…) weigh `LAUGH_W` (4) times hype, with their own spikes (`laughSpikes`) so a funny moment stands out in an always-busy chat; laughter in the audio (`laughBursts`: 4+ short bursts in 3 s, 4 dB over the stream's median, from a 0.1 s loudness series); laughing Whisper wrote into the transcript (`transcriptLaughs`: "haha", "[laughter]", lol). `hotspots` ranks chat laughter highest (to 98), hype-only chat tops out at 55, a bare audio jump at 40, so volume or hype alone isn't proof; a laughing window outranks an equal hype one (`laugh` on each hot window). `PICK_SYSTEM` is a comedy brief (setup + payoff inside the clip, reaction peak, cold-viewer test, hook in 2 s, ends 1-3 s after the laugh; rants, stat talk and inside jokes rejected) and the model rates every candidate **1-10 for funniness with a one-line reason**; `funnyOnly` drops anything under `MIN_FUNNY` (7) and orders by that rating, **fewer is better, an empty list is valid, weak clips never pad it** (up to `MAX_CANDIDATES` 12). Hot windows the model passed over are added back only if they carry laughter (`seedCandidates`, not under a focus). `server/clipJudge.js` then sends 3 small frames of each of the top `CLIP_VISION_MAX` (6) candidates, with the window's words and the viewer evidence, through `lookAtImages` for a funny / visual / reaction / standalone rating, blended with the text score (`blendScore`, `rerank`; a judged clip under `MIN_FUNNY` 6 is dropped, no minimum count kept). YouTube section downloads made for the check are reused by the render and deleted for losers. `CLIP_VISION=off` skips it; no vision key or a failed look falls back to the text ranking and the result says so. A video over `CLIP_SCAN_MAX_MIN` with no most-replayed graph is windowed by chat laughter density (`bestWindow(…, chat)`, the 3 h with the most laughing chat; the result says which signal chose it) rather than the start. `node server/scripts/test-clip-scan.js`, `test-clip-signals.js`.

**Clip speed:** finished clips play 1.5x faster (`clipSpeed` in `server/clipLayout.js`: `app_settings.rogue_clip_speed`, then env `CLIP_SPEED`, default 1.5 since 2026-11-23, clamped 1.0-1.5, 1.0 = off; a stored 1.1, the old default, is ignored via `legacySpeed`, so only another value is a real choice): `setpts=PTS/s` + `atempo=s` in the final render (pitch stays normal), captions and hook rescaled by the same factor in `buildAss`; ranges in the result stay in source time; `rawEdit.js` is untouched.

## R.O.G.U.E. edits his raw footage (`server/rawEdit.js`, `RAW_EDIT=off` to stop)

`[RAW_EDIT: Drive link(s) | notes]` (R.O.G.U.E., J.A.R.V.I.S.; A.R.A. relays to her) turns his own talking-head recordings into finished 9:16 videos (owner's ask 2026-11-21, after the Grokbot reel): Whisper word timestamps → `lines` → one Claude call (`plan`) keeps the last full take of each line and drops false starts and stumbles, and picks punch-ins, title cards, the hook, keywords and a song → `segments` cuts dead air (`LEAD` 0.06 s before the first word, `TAIL` 0.08 s, about 2 frames, after the last; pauses over 0.45 s inside a line cut too) → one ffmpeg pass: `select`/`aselect` the segments at 30 fps, fill 9:16, `zoompan` punch-ins, clipLayout's word-by-word captions + hook remapped to the cut (`remap`), title cards (`titleAss`), music from the Drive folder "R.O.G.U.E. Music" (`app_settings.rogue_music_folder`, `driveFolderAudio`) mixed low. A failed styled render falls back to the clean cut. Several links are a batch, 2 at a time, each sent from A.R.A. as it finishes, uploaded as `Edit — <title>`. Style: `[STYLE_LEARN: handle or reel links]` watches up to 5 of his edits (3 frames each through the vision chain, words/sec and pauses) into `app_settings.rogue_style` (summary + render prefs); `[STYLE_NOTE]` adds his corrections, which win. Listing an Instagram profile needs `INSTAGRAM_COOKIES`; reel links work without. Raw files sent on Telegram aren't taken yet (bots can download only 20 MB). `node server/scripts/test-raw-edit.js`.

## Download logins kept alive by J.A.R.V.I.S.'s browser (`server/siteLogins.js`, `SITE_LOGINS=off` to stop)
 `emailCode` now uses `waitForEmailAuth` (10 min, newest only, codes), and `wantsEmailCode` also catches "link" / "magic" / "sign in" screens.

YouTube and Instagram refuse logged-out downloads from the server. With `YOUTUBE_LOGIN_EMAIL` + `YOUTUBE_LOGIN_PASSWORD` (a spare Google account) / `INSTAGRAM_LOGIN_USER` + `INSTAGRAM_LOGIN_PASSWORD` in the secrets, J.A.R.V.I.S.'s browser signs in (`signIn`; the brain types `{{USER}}`/`{{PASSWORD}}` and `runTask's` `secrets` fill them in, so the password never reaches a model; `allow` lets the consent buttons through) and its cookies are written as `~/.empire-bin/cookies/<site>.txt` (`toNetscape`), which `cookieArgs` uses when no `YOUTUBE_COOKIES` / `INSTAGRAM_COOKIES` is set. Every `ytdlp()` call adds the login itself; refused for one, `ensureLogin` signs in again (at most every 30 min) and the call is retried once with the fresh cookies. R.O.G.U.E. → J.A.R.V.I.S. is posted in the Empire group; a code sent by email is fetched from his Gmail (`emailCode`, A.R.A.'s inbox, last hour, the site's sender) and typed in (`{{CODE}}`) with no stop; when it needs him (a texted code, a phone approval, a checkpoint) J.A.R.V.I.S. hands it to A.R.A., who tells him from her bot (voice + text, `sendFromAra`) with a screenshot, at most every 12 h; the hand-off shows in the group. `[SITE_LOGIN: youtube|instagram]` (J.A.R.V.I.S.) signs in now. Owner's call 2026-11-21. `node server/scripts/test-site-logins.js`.

## Speech-to-text: Groq first, OpenAI behind it, every call measured (`server/llm.js` `stt`, `server/transcribeUsage.js`)

Owner's ask, 2026-11-24. Every server Whisper call (`transcribe` voice notes, `transcribeSegments` for clip scan / auto clip / `[TRANSCRIBE]`, `transcribeWords` for clip captions and raw edits) goes through `stt()`: first Groq's OpenAI-compatible endpoint (`https://api.groq.com/openai/v1/audio/transcriptions`, model `whisper-large-v3-turbo`), then OpenAI `whisper-1` with the same parameters. Both get `response_format=verbose_json` always, plus `timestamp_granularities[]=word` and `segment` for words, so `avg_logprob`, `compression_ratio` and `no_speech_prob` still reach `transcribeWords`' invented-word filter. **Key:** env `GROQ_API_KEY`, else `app_settings.groq_api_key` (a synced setting, so no Replit secret is needed: tell J.A.R.V.I.S. or set it in the app's settings table). **Falls back to OpenAI** on: no Groq key, a chunk over 25 MB (Groq's free-tier file limit, checked before sending), any non-OK Groq reply (429, 5xx, 401...), a 120 s timeout or network error, or a response with text but no word timestamps when words were asked for. A 429 also pauses Groq until its Retry-After (60 s default, 10 min max) so the 20 requests/min, 7200 s/hour and 28800 s/day free limits don't cost a failed round trip per chunk. OpenAI needs `OPENAI_API_KEY`; if Groq failed and there is none, the error says both. The Groq request shape (verbose_json + granularities) follows Groq's docs but was not run against the live API from the build runner (no key there): the "no word timestamps" fallback is the safety net if it ever returns none.

**Usage log:** each call is appended to `app_settings.transcribe_usage` (`{ entries, days }`): time, provider, `fallback` and `why`, job (`clip scan`, `auto clip`, `clip captions`, `raw edit`, `transcribe`, `voice note`, `other`; callers pass `job`), audio seconds (the reply's `duration`) and bytes. Entries are kept 90 days; older ones roll into per-day totals (kept). A failed write logs `transcribe usage failed: …` and never blocks a transcription. `[TRANSCRIBE_USAGE]` (J.A.R.V.I.S., A.R.A., R.O.G.U.E.) reports this month and the last 7 days: audio hours, hours per job, Groq vs OpenAI hours, fallback count and reasons, estimated cost (Groq $0.04/hour, OpenAI $0.006/minute). `node server/scripts/test-transcribe-usage.js`.

## Transcripts of any video link (`server/transcribe.js`, `TRANSCRIBE=off` to stop)

`[TRANSCRIBE: link]` (every persona) takes a YouTube, Instagram (reel / post / IGTV), TikTok or Google Drive link to one video: yt-dlp (or Drive) downloads it the same way the clip scan does (`downloadYouTube` in `server/clipScan.js`, which now also takes `isSocialVideo` links), Whisper (Groq first, see Speech-to-text above) transcribes the audio in 10-min chunks with timestamps (no persona-name prompt for other people's videos), and the transcript is saved as the Drive note `Transcript — <title>`. On Telegram it's a lookup tag: the transcript comes back into the persona's turn (first 40k characters), so it can summarize or quote it right away. In the app (`commandHandler.js` → `onTranscribe` → `startTranscribe` → `POST /clips/transcribe`) it runs in the background and arrives on Telegram from the asking persona's bot (else A.R.A.'s). Instagram sometimes refuses logged-out downloads; `INSTAGRAM_COOKIES` (cookies.txt text) or `INSTAGRAM_COOKIES_FILE` on the server gives yt-dlp a session, and the error says so. Two at a time; same size and length caps as the clip scan. `node server/scripts/test-transcribe.js`.

## R.O.G.U.E.'s auto clips (`server/autoClip.js`, `AUTO_CLIP=off` to stop)

`[AUTO_CLIP: channel or video link]` / `[AUTO_CLIP_OFF: channel]` / `[AUTO_CLIP_LIST]` (R.O.G.U.E., J.A.R.V.I.S., A.R.A.) watch up to 10 YouTube channels (resolved with yt-dlp). Every 20 min the cron reads each channel's public RSS feed (no key or quota); uploads after the channel's mark (set to its newest video when added, so no back catalog) are queued, Shorts left out, and one is clip-scanned per tick, oldest first: under `AUTO_CLIP_MIN_MIN` (3) min skipped, still live waits, `AUTO_CLIP_MAX_PER_DAY` (3) scans a day. Results go to him from A.R.A. on Telegram like an app-started scan, plus a push. YouTube refuses logged-out downloads from the server's datacenter IP ("Sign in to confirm you're not a bot"): `YOUTUBE_COOKIES` (cookies.txt text) or `YOUTUBE_COOKIES_FILE` gives every yt-dlp YouTube call a login (`cookieArgs` in `server/clipScan.js`, added inside `ytdlp()` so channel lookups and length checks carry it too), and the error says so. A video blocked that way stays queued (told once, not counted toward the day) for up to 3 days, and once the cookies are set, ones that already failed that way go back on the queue. **Topic filter** (owner, 2026-11-22): `[AUTO_CLIP: channel | GTA]` watches a channel for one subject; an upload whose title or yt-dlp tags don't mention it (whole words, aliases like "grand theft auto", commas = any of) is skipped as `off topic`, with no scan and not counted toward the day, and the next queued one is looked at in the same tick. `[AUTO_CLIP_TOPIC: channel | topic]` changes it, `any` clears it; the list shows each channel's topic. State: `app_settings.auto_clip`. `node server/scripts/test-auto-clip.js`.

## J.A.R.V.I.S.'s and A.R.A.'s browser (`server/browserAgent.js`, `BROWSE=off` to stop)
 **Emailed codes and magic links** (`browseRun` → `emailedCode`): on a "check your email" screen the run waits for the newest email from that site after that moment (20 s polls, 10 min), then the SAME browser (same persona profile) types the code or `goto`s the link (a magic link only works in the browser that asked); a click that would buy/delete/send still stops at `isCommit`. No email → the result says none arrived in 10 minutes.

`[BROWSE: task]` (J.A.R.V.I.S. and A.R.A. only, `BROWSE_PERSONAS`; owner's call 2026-11-20) drives a real Chromium over the DevTools protocol (`ws`, no new dependency): each turn the page goes to `claudeText` as text (URL, title, numbered elements via `data-eid`, visible text) and one JSON action comes back (goto / click / type / select / press / scroll / back / wait / done / ask), up to `BROWSE_MAX_STEPS` (300) / `BROWSE_MAX_MIN` (60; owner raised it from 6, 2026-11-22). A click or Enter that acts in the world (`isCommit`: send, post, connect, buy, book, delete, confirm…; not sign-ups, which are his standing order, 2026-11-22) stops the run as an `ask`; a code a site emails is fetched from his Gmail and typed in automatically (`emailedCode`, last 15 min, any sender); it goes through only on a follow-up [BROWSE] whose owner message says yes (`approves`). Page text is data, not instructions. One profile per persona (`BROWSER_PROFILES`, default ~/.empire-browser/<id>) so logins persist; one Chrome per persona, closed after 10 idle min, 3 at most. The result returns into the turn and a screenshot of the last page goes out (`kind: 'photo'` buffer in `sendMedia`). Chrome is the free self-contained `@sparticuz/chromium` build, fetched once into ~/.empire-bin/chromium with its own libraries on `LD_LIBRARY_PATH` (the plain headless shell needs ~20 system libraries the server doesn't have); not yet run on the live server. `BROWSER_WS_URL` (a hosted browser), else `app_settings.browser_ws_url` (set by J.A.R.V.I.S.'s `[BROWSER_KEY: Steel key or wss:// url]`, no Replit secret needed), or `CHROME_PATH` override it. The free Chrome is stopped by Cloudflare checks (Canva, Steel's own sign-up, 2026-11-22); a hosted one is the way past. In the app (J.A.R.V.I.S. and A.R.A.'s direct chats; their `buildSys` carries the tool line), `CommandScreen`'s reply loop runs [BROWSE] like a read: `runBrowse` (`src/services/clipScan.js`) starts `POST /browse` (`server/routes/browse.js`, an in-memory job) and polls `GET /browse/:id` up to 65 min, the result goes into the second pass, and the screenshot goes to Telegram. `node server/scripts/test-browser-agent.js`.

**Emailed sign-in links** (owner's bug, 2026-11-24: Groq's Stytch login emails a magic link, not a code): `wantsEmailLink` (`server/siteLogins.js`) spots a page or stop text saying a sign-in / verification / magic link was emailed; `browseRun` then calls `emailedLink` (`server/browserAgent.js`), which waits up to 3 min (`EMAIL_LINK_WAIT_MS`) for an email sent after the run reached that screen (45 s slack, older mail never used) and takes the URL `pickAuthLink` picks (help / privacy / unsubscribe skipped). The follow-up `runTask` runs on the SAME persona browser and profile with the URL as the `LINK` secret (the task only says `{{LINK}}`, so the model never sees it), plan carried over, `ownerText: 'yes'`; the code path is unchanged. A.R.A.'s find for a worker (`kind: 'link'`) continues in the same `worker-<id>` browser (kept open, 10 idle min) with `LINK` as a secret too. A magic link opened later or in another profile fails (Stytch `redirect-error`). `node server/scripts/test-emailed-link.js`.

**Brain replies and idle waits** (owner's bug, 2026-11-24: Groq sign-up workers 63-65 stalled on "no action in the reply (keys: thought, action)"): `parseAction` takes the first balanced `{…}` that parses (fenced, prose around it, trailing braces) and accepts the action as a string with its fields beside it, an object (`type` / `action` / `name` / `kind` / `tool`, nested, or in an array), or the one-key forms `{"ask":"…"}`, `{"click":7}`, `{"wait":true}` (also top level); `ask_user` / `request_info` = ask (`message` / `prompt` become `question`), `sleep` = wait, `answer` / `summary` = a done's result. Fixture of real shapes: `server/scripts/fixtures/browser-brain-replies.json`. **Waits are capped** (`waitGuard`, `MAX_IDLE_WAITS` 3): the 4th `wait` in a row on an unchanged page isn't executed, the brain is told to take its next planned step, and a 5th ends the run `stopped` with that reason. **An info ask never idles:** a stop that mentions a code, sign-in or magic link (`wantsEmailCode`, now also "magic link" / "sign-in link") goes to `emailedCode` (`waitForEmailAuth`, newest email, 10 min) and the URL is `goto`ed in the same browser; a worker's other info asks go to `asksForInfo` → `findForJob` on the question itself (`r.result`, not the whole report), and a not-found ends as needs-you, never a silent wait. `node server/scripts/test-browser-agent.js`.

## Open threads (`server/openThreads.js`, `OPEN_THREADS=off` to stop)

Every 3 h (:15) one Claude call reads the last ~day of conversation (every persona's `tg_messages` plus `persona_memory` rows, which is how app chats and relays show up) and the current list, and rewrites the Drive note "Open Threads": topics he advanced and then set aside, how far each got, the next step. Finished or dropped threads come off; skipped when nothing new (`app_settings.open_threads_last`). `[OPEN_THREADS]` (every persona) reads it. Owner's request, 2026-11-20. `node server/scripts/test-open-threads.js`.

## How Mr. Burrus works (`server/ownerProfile.js`, `OWNER_PROFILE=off` to stop)

The "learns you" piece of his smart-AI ask (2026-11-20). Every 6 h (:45) one Claude call reads the same ~day of conversation as the open threads plus the current profile and returns his preferences, standing decisions, corrections and communication style (only what he said or showed; newer replaces older), each line tagged `[all]` or with the persona id(s) it is for. No cap and no rotation (owner, 2026-11-22): a line leaves only when the model lists it under `REMOVED:`; anything else it leaves out is put back (`normalize`); `PINNED` lines can never be removed; past 150 lines the sentinel tells him to tidy it. Untagged lines count as `[all]`; dates before 2026 are corrected. Stored in synced `app_settings.owner_profile`, mirrored to the Drive note "How Mr. Burrus Works". Each persona gets the `[all]` lines and its own (`linesFor`; A.R.A. and J.A.R.V.I.S. get every line, `SEES_ALL`): Telegram turns and relays (`profileBlock(id)`) and the app (`profileFor` in `buildSys`, `src/services/aiService.js`; `test-owner-profile.js` fails if the copies drift). The morning brief also carries an OPEN THREADS section (`threadsSection`). `node server/scripts/test-owner-profile.js`.

**`[SET_RULE: who | rule]`** (every persona; `who` = `all` or persona ids, comma-separated; `setRule`/`parseRule` in `server/ownerProfile.js`, app copy in `commandHandler.js`) saves a standing rule he states **immediately** into `owner_profile` (and the Drive note) instead of waiting for the 6-hourly pass; only on his own top-level message (not relays, jobs or bot-sent turns), deduplicated, dated; `tick` re-reads the profile after its AI call so a rule saved meanwhile is never lost. `node server/scripts/test-owner-profile.js`.

## Day nudges (`server/dayNudge.js`, `DAY_NUDGE=off` to stop)

Thinking ahead during the day (2026-11-20): at 11 AM, 3 PM and 7 PM ET one Claude call looks at the next 24 h of his calendar, open tasks due today or overdue, and the open threads, and A.R.A. sends one short nudge only when something needs him soon (`NOTHING` stays quiet). Items already nudged that day are skipped (`app_settings.day_nudge_seen`). `node server/scripts/test-day-nudge.js`.

## A.T.L.A.S.'s money watch (`server/moneyWatch.js`, `MONEY_WATCH=off` to stop)

Money in and out, logged without him telling her (2026-11-20; no bank statements, his call). Every 2 h (:30) it searches his Gmail (last 3 days, money words) for messages not yet seen (`app_settings.money_watch_seen`), and one Claude call keeps only real USD movements with an amount (sales, payouts, payments, charges, bills, refunds) and maps each to a business from `business_targets` or "Personal" (`matchBusiness`). Each goes into the synced `revenue` table (`auto: true`, `source_email`), which the HUD's month-to-date reads, and A.R.A. sends one summary of what was logged. Transfers between his own accounts aren't counted (owner's call): his name on both ends (`OWNER_NAME`/`ownName` — Tarell Burrus and its misspellings, flagged to the model), the bank calling it a transfer, or the same amount out of one account and into another within 2 days (`pairTransfers`); the summary lists them, and an earlier logged entry that turns out to be the other side is flagged to check. At 9:45 PM ET `dailyReport` runs a last sweep and A.T.L.A.S. gives A.R.A. the day's in, out and net in dollars (no ratio, his call) with each entry (`dayReport`). On the last day of the month, 9:50 PM ET, `monthReport` sends the month's total in, out and net per business (`monthSummary`). `[MONEY_IN_OUT]` (A.T.L.A.S., A.R.A.) gives this month per business. **Subscriptions** (owner's request, 2026-11-20): the same pass marks recurring charges (`subscription`, `cycle`) and subscription notices with no charge yet (renewal, trial ending, price change, cancelled, payment failed; `parseNotices`); `updateSubs` keeps `app_settings.atlas_subscriptions` (amount, cycle, last charged, next due, status, price change), the summary flags new ones and notices, the 9:45 report lists renewals in the next 3 days (`dueSoon`), and `[SUBSCRIPTIONS]` (A.T.L.A.S., A.R.A.) reads the list with a monthly total. Cancelling stays his call. T.A.L.O.N.'s demo trades aren't logged. `node server/scripts/test-money-watch.js`.


## The website desk (`server/siteDesk.js`, `SITE_DESK=off` to stop)

Owner's call, 2026-11-21: S.C.O.U.T. finds local businesses, J.A.R.V.I.S. builds each a new website, S.C.O.U.T. emails the owner the link with the offer. Every 30 min, 9 AM-6 PM ET, up to `site_desk_per_day` (3) a day: a Google Places text search (`GOOGLE_PLACES_API_KEY` or `GOOGLE_MAPS_API_KEY`: real phone, address, hours, rating, reviews, photos; without a key a web search stands in and `[SITE_DESK]` says so) over its own local-business `SEGMENTS` × the `scoutTargets` metros; no site (or only a Facebook/booking page) first, chains and anything already a lead skipped. A business with a site gets it as the template (`readOldSite`: its words, images, logo, colors, email, plus its about/services/contact pages). No email (old site, then one search, `pickEmail`: own domain or a free mailbox) means no build. Then one Claude call each: S.E.L.E.N.E.'s design direction, S.C.R.I.B.E.'s copy, J.A.R.V.I.S.'s single-file HTML (`SITE_DESK_MODEL`). Facts only from the listing and the old site (`NO_INVENTING`); `finishHtml` drops outside scripts, makes forms inert, swaps any image it wasn't given for a generated one (`GEN:` → Pollinations), adds noindex and a "Preview… by Empire Digital" ribbon; `checkHtml` (length, placeholders, the real phone, the name) gets one rebuild. Pages live in the `demo_sites` table, served publicly and sandboxed at `/sites/<slug>` (`routes/sites.js`). The first 3 wait for him (A.R.A. sends the link; `[SITE_APPROVE]` emails it then, `[SITE_REVISE: name | changes]`, `[SITE_DROP]`); after that each is emailed as built and he gets the link. The email (`emailFor`) carries the link, the offer (`[SITE_OFFER]`, default `DEFAULT_OFFER`: $497 setup, shown as an early-bird rate off the regular $995, + $347/mo; no round numbers in Empire Digital pricing, owner's call 2026-11-21) and an opt-out line; the business becomes a `leads` row at `contacted` with the link in its log, so the outreach loop's follow-ups pick it up. Tags for J.A.R.V.I.S., A.R.A., S.C.O.U.T.; writes need his own message. State: `app_settings.site_desk`. `node server/scripts/test-site-desk.js`.
## The app matches Telegram (`server/routes/shared.js`, `src/services/sharedDesk.js`)

Owner, 2026-11-26: "both Telegram and the app should have the matching changes". As with S.T.E.P.H.A.N.I.E.'s course, the app asks the server instead of keeping a copy. `buildSys` adds `GET /shared/context?persona=` (the on/off switches for A.R.A. and J.A.R.V.I.S. and "pass it to A.R.A." for everyone else, T.A.L.O.N.'s trading switch, A.R.A.'s W.I.R.E. brief with `[NEWS_NOW]` / `[BREAKING_NOW]`, S.T.E.P.H.A.N.I.E.'s drill and answer key, the follow-through rules). `CommandScreen`'s reply loop sends those tags to `POST /shared/tags` (`SHARED`, run by `runInjections` with his words) and, before the lookups, asks `POST /shared/follow` for the follow-through notes. One more call runs on them, and its tags join the reply's. A final reply that still promises a check is scheduled to come back on that persona's Telegram bot (`final: true`). `stripCommands` hides the new tags. Groq voice needs no app change (`routes/ai.js`). App changes ship in the next APK. `node server/scripts/test-shared-route.js`.

## Saying you'll check means coming back; nobody asks him for what the team has (`server/followThrough.js`, `FOLLOW_THROUGH=off`)

Two owner rules, 2026-11-26, checked on every persona's Telegram reply in `runPersonaTurn`, after the promised hand-off round:

- **"If a persona says they will check something they must come back."** `promisedCheck` finds "I'll check / let me look / I'll get back to you / give me a minute" (offers and questions don't count). The persona gets one more round (`CHECK_ROUND`) to do it now with its tags and give the answer itself. If the reply still promises it, `scheduleFollowUp` runs that persona's turn again 2 minutes later (`FOLLOW_UP_DELAY_S`) on its own bot, prefixed `[SENT ON YOUR OWN — a follow-up you promised him`, so his gates don't treat it as his words and it never schedules another; at most 3 pending.
- **"I only hear about what actually needs me" — every persona.** `asksOwner` finds a reply asking him for something (send me, what's your email, can you share…) that isn't `onlyHim` (`workers.js`) or a decision that's his. The persona gets one round (`ASK_ROUND`) to get it from whoever has it (`[RELAY_TO]`, its tags) and carry on; the question stays only if that fails, saying who tried.

The app runs the same checks through `/shared/follow` (below). `node server/scripts/test-follow-through.js`.

## Saying a hand-off isn't doing it (`promisedHandoffs`, `server/personas.js`, mirrored in `src/personas/personas.js`)

Owner's complaint, 2026-11-21: A.R.A. wrote "Relaying the fix to Atlas now." and no `[RELAY_TO]` ever went out. `promisedHandoffs(text, names, self)` finds the personas a reply says it's handing something to (relay / pass / hand / send / tell / let … know / ask … + a persona's name as written, A.T.L.A.S. / ATLAS / Atlas; offers and negatives don't count). On Telegram (`runPersonaTurn`), after the lookup rounds, any named persona no relay reached (`sink.relayed`) gets one more round: the persona is told it said it but didn't, emits the `[RELAY_TO]`, it runs, and the reply is rewritten from the receipts; if it still didn't go, the receipt footer says nothing was sent. In the app, a reply with no `[RELAY_TO]` that promises one gets one call for the tags before the relays run, and a final reply that still claims one gets a ⚠️ line. `node server/scripts/test-relay-promises.js` (also fails if the two copies drift).

## A.R.A. always sees his calendar (`calendarBlock`, `server/personaRuntime.js`; mirrored in `buildSys`, `src/services/aiService.js`)

Owner's complaint, 2026-11-21: "what time is the party?" was answered from the chat because her calendar was only a tag she had to choose to run. Every A.R.A. turn now carries his Google Calendar, today through the next 15 days, read live (server cache 60 s, cleared after any event write), with the rule that when/what-time/where questions are answered from it first, never from chat or memory; not on it → she says so, then checks tasks, dates and reminders. A failed read tells her to emit `[READ_CALENDAR]` before answering.

## J.A.R.V.I.S.'s workers (`server/workers.js`, `WORKERS=off` to stop)

Owner's idea, 2026-11-22: J.A.R.V.I.S. stays at the front desk and hands every task, whatever its length (FRONT DESK RULE in `engineBrief`, `server/jarvisEngine.js`), to workers of his own, so he is free to talk 100% of the time. `[WORKER_START: code|browse | title | task | Drive note]`, `[WORKER_STATUS]`, `[WORKER_STOP: id]` (J.A.R.V.I.S. only). **Hard cap: 3 running at once, total** (`HARD_CAP`; `WORKERS_MAX` can only lower it; owner: "3 and 3 only"), the rest queue. Internal ids only count up (`workers_seq`) and aren't shown to him. A **code** worker runs on its own GitHub Actions runner with its own Claude Code (`.github/workflows/worker.yml`), never on the server (on the 2 GB VM they froze it, 2026-11-22): the server opens an issue holding the task (label `worker`, "@claude" defused so `claude.yml` stays out), fires `repository_dispatch` `worker-run`, and polls the issue every minute (`WORKER_POLL_MS`) for the job's `<!-- worker-result -->` comment; the job works on `worker/<id>-<slug>` cut from main, commits, pushes that branch only, and reports DONE / PARTLY DONE / FAILED with its proof. A run GitHub never starts (6 min), one that ends without a report, or one past 130 min (`WORKER_CODE_MIN`) fails and says why; `[WORKER_STOP]` cancels its run. A **browse** worker runs `browseRun` on the server on its own profile `worker-<id>`, one at a time behind the memory gate (`cliSlot` 'heavy'), its result saved to the named Drive note. **Every browser shares one set of logins** (`loadJar` / `saveJar` in `server/browserAgent.js`): cookies are loaded into each browser when it starts (local Chrome or hosted) and saved back to `<BROWSER_PROFILES>/shared-cookies.json` (mode 600) after every task, merged by name/domain/path; before this a fresh worker had no logins and asked him to sign in to Google Drive (2026-11-22). Files in his Drive are read with the Drive tags, not a browse worker. **He sees slots, not ids:** each running worker holds slot 1-3 (`slot`), shown as "Worker 2 of 3" in reports, `[WORKER_STATUS]` and the app strip; `[WORKER_STOP: 2]` stops slot 2 (an id still works). Workers are J.A.R.V.I.S. (owner, 2026-11-22): every report, questions included, comes from his bot. **A.R.A. finds it first** (`server/araFinds.js`, `ARA_FINDS=off`): a browse worker that stops for information (a sign-in, an account email, a code, a link; `asksForInfo` — never his OK to act) has A.R.A. search his Gmail and Drive notes (`findForJob`: one call plans the searches, one pulls out the exact value or NOT_FOUND), and it carries on with it (`{{INFO}}`, typed by the browser, so a password never reaches the page-reading model or the group chat); up to twice. The hand-off is posted in the Empire group. Only what nobody can supply reaches him. For a code or sign-in link on a known site, `findForJob` uses `waitForEmailAuth` (newest email after the screen, 10 min; a link comes back as the URL for a `goto` in the same browser) and a `{{…}}` placeholder is never returned as a value (`isPlaceholder`). Both rules are pinned in his profile (`PINNED`, `server/ownerProfile.js`). `node server/scripts/test-ara-finds.js`. **Every result goes straight to Mr. Burrus on J.A.R.V.I.S.'s bot** (`report` → `tell`; logged in his chat history, so J.A.R.V.I.S. sees it) with the issue link as proof — no engine turn, so J.A.R.V.I.S. is never tied up checking one. Each step is written to `app_settings.workers`; `GET /workers` feeds the app's strip (`fetchWorkers` in `src/services/sentinel.js` → worker chips in `NudgeBar`, with `url` = the GitHub run or issue). At boot `recover()` goes back to watching code workers (the runner kept going; no re-run) and re-queues a cut-off browse once. Failures log as `workers failed: …` for the sentinel. Every worker failure (any kind, with its cause) is logged as `workers failed: #id title: reason` and appended to `app_settings.worker_failures` (last 50, survives restarts); `[WORKER_STATUS]` shows a failed / stopped / needs-you worker's reason (first 200 chars, "no reason recorded" if empty); a browse worker task holding a drive.google.com / docs.google.com link is refused (`DRIVE_LINK`; Drive files are read with `[READ_FILE_ID]` etc.). Needs `GITHUB_TOKEN` on the server and `CLAUDE_CODE_OAUTH_TOKEN` as a repo secret. `node server/scripts/test-workers.js`. **Progress is real, not a timer** (owner, 2026-11-22): each worker plans its own steps and `percent` = steps done / steps, held at 95 until the run really ends, 100 only on success; a failed or stopped worker keeps its last number; no plan yet → `percent: null` ("planning"). A code worker is told (worker.yml prompt) to write `.worker-plan.md` (`1. [ ] step`, ticked `[x]` as it goes, gitignored) and the job mirrors it every 15 s into an issue comment marked `<!-- worker-plan -->`; the server reads the newest one in the same poll as the result (`readPlanComment`, `parsePlan`). A browse worker's plan is the browser brain's `plan` + `planStep` (`onPlan` from `runTask` through `browseRun`, `planTracker` in `server/browserAgent.js`). `percent` / `current` / `plan` are in `app_settings.workers` and `GET /workers`; the app's chip (`NudgeBar`) shows a thin bar + the current step, the plan with ticks on tap. **Telegram board:** while any worker runs or waits, J.A.R.V.I.S.'s bot keeps ONE silent message listing them ("Worker 2/3 title · N min", `▓▓▓▓▓░░░░░ 50% · step`), edited in place (`editMessageText` in the `tg` helper, at most every 10 s, unchanged text skipped; finished / failed / needs-you stay 15 min; a last "all done" edit closes it, the next worker opens a new one). Its id is `app_settings.workers_tg_board`, so a restart keeps editing it; only the first send is logged in his history; a failed edit logs `workers failed: telegram board: …`; `WORKER_TG_BOARD=off` stops it. **Pinned** (owner, 2026-11-23): a new board is pinned silently at the top of his chat with J.A.R.V.I.S.'s bot (`pinChatMessage`, `disable_notification`), once, with `pinned` saved next to the id in `app_settings.workers_tg_board` so edits and restarts never pin it again; the all-done edit unpins it (`unpinChatMessage`), and a board replaced because it was deleted or uneditable unpins the old one before the next is posted and pinned. A pin or unpin failure never blocks posting or editing: it logs `workers failed: telegram board pin: …` (a failing pin is tried 3 times, then left) for the sentinel. `WORKER_TG_PIN=off` makes no pin calls.

**Workers use his command tags** (`server/workerTools.js`, owner, 2026-11-23: "workers are him with no limitations"): a code worker runs any of J.A.R.V.I.S.'s tags from its shell with `node scripts/jarvis-tool.js '[TAG: args]'` (or the tag text on stdin), which POSTs to `POST /worker-tools/:id` (`server/index.js`) and prints the receipts. Auth is a per-worker token (`grantTools` in `workerTools.js`, `app_settings.worker_tool_grants`, `WORKER_TOOLS_H` 12 h, revoked when the worker ends) sent as `tools_token` in the `worker-run` dispatch payload next to `files_token`, masked and exported as `WORKER_TOOLS_TOKEN` by `worker.yml` (with `EMPIRE_URL` and `WORKER`; those `worker.yml` edits ship as `scripts/worker-yml-tools.patch` — `git apply` it — because the worker's GitHub App can't push workflow files), never in the public issue; the worker prompt lists the tag families. The tags run through the same `runInjections` / `applyEffects` as his Telegram turn, as persona `jarvis`, one hand-off deep (so `[RELAY_TO]` skips the top-level gate like any job). **Anything that acts in the world does not run:** `GATED` tags (`WORKER_SHIP`, `SITE_APPROVE`/`DROP`/`REVISE`, trades and stop/target moves, every `SEND_*` and media tag, `AUTO_CLIP*`) become a `tg_pending` card of kind `worker_tag` on his bot and run only on his Confirm tap (`runConfirmed`, called from `runPending`); tags whose own code already proposes a card (`SEND_EMAIL`, `DELETE_*`, `BUILD_MERGE`, `REDEPLOY`, `LEAD_EMAIL`, `BUILD_REQUEST`) use it, and the card is sent from the endpoint. The receipt says "waiting on his tap, it has NOT run". Every call is logged with the worker id (`app_settings.worker_tool_log`, last 200, and the server log). A card that can't be sent goes to him through `loud.tellAra`. `node server/scripts/test-worker-tools.js`.

**Voiced reports** (owner, 2026-11-23): every final report and needs-you question (`defaultReport` → `voiceThenText` in `server/workers.js`) goes out as a voice note from J.A.R.V.I.S.'s bot in his own steady voice (`voiceNote('jarvis')`), then the text exactly as before. The spoken version is built in code, no AI (`spokenReport`, at most `VOICE_MAX` 600 characters): "Worker 2, <title>, is done / partly done / failed / needs you", one or two sentences of the report, and what to do ("Say push to ship it."); URLs, paths and branch names, commit hashes, issue numbers and code are stripped, `speakNames` applied. The voice never holds the text back past `VOICE_TIMEOUT_MS` (75 s); a failure logs `workers failed: voice for #id: why` for the sentinel and the text still goes. The live board and its edits are never voiced. `WORKER_VOICE=off` stops it. `node server/scripts/test-workers.js`.

**Big jobs** (owner, 2026-11-23, after the website rebuild: "I need jarvis bots to be able to handle big jobs like this"): a code worker's run gets 170 min (job limit 200, `WORKER_CODE_MIN` 210 per run on the server); a job too big for one run ends with a report starting CONTINUE (or hits the time limit, work committed) and the server dispatches the next run on the same branch and issue (`leg` in the payload; the plan comes back from the issue's `<!-- worker-plan -->` comment and the earlier reports go in its prompt), up to `WORKER_MAX_RUNS` (3) runs. The runner installs ffmpeg + ImageMagick (Chrome is preinstalled); the prompt lists the tools and says large media goes to a GitHub release, never the repo, and that the server only downloads `server/`. **His Drive from a worker:** Drive links (or `drive: <id>`) in a code worker's task get a token (`grantFiles` / `fileGrant`, `app_settings.worker_file_grants`, that worker and those files only, `WORKER_FILES_H` 12 h) sent in the dispatch payload, masked in the job, never in the public issue; the worker downloads with `GET /worker-files/:id` (`x-worker-token`; `driveStream` in `google.js` streams it, Docs/Sheets/Slides as PDF or `?format=text`). `node server/scripts/test-big-jobs.js`.

**Everything has a spoken on/off switch** (owner, 2026-11-26: "everything should have a verbal on or off switch if I say"; `server/switches.js`). Every scheduled loop and desk has a name in `SWITCHES`. Each is checked before every run: `schedule(key, …)` in `index.js` wraps each cron, and W.I.R.E.'s fan-out to A.T.L.A.S., W.O.K.E. and H.A.V.E.N. goes through `ifOn`. `[SWITCH_OFF: what he named]` / `[SWITCH_ON: …]` / `[SWITCHES]` are in every persona's Telegram prompt (next to `OBEY`), run only on his own message, match his words fuzzily (`match`; "all" = everything but the sentinel and reminders), and write `app_settings.switch_<key>`, which survives restarts. New loops must get a key here and go through `schedule`. The env kill switches remain for the deployment. The app runs the same tags through `/shared` (see below).

**One market at a time, and done for the day after two losses** (owner, 2026-11-26: "tell Ara to have Talon stop trading single pairs", "if we lose twice in a day he stops trading for that day"; `server/talonSwitch.js`). `[TRADING_OFF: bitcoin]` (gold / nasdaq / several) stops only that market (`app_settings.talon_halt_markets`): it isn't scanned, gets no quick scalps, add-ons, re-entries or news trades, and `tlPlaceOrder` refuses it (`blocked`). A plain `[TRADING_OFF]` still stops everything (the safe side); `[TRADING_ON: bitcoin]` on his words turns that one back on, and a plain "start trading" turns every market back on. `[SWITCH_OFF: bitcoin]` does the same (`gold` / `bitcoin` / `nasdaq` keys in `switches.js`). **Two losing trades closed today** (ET, all markets; a scalp + swing pair or a setup with its add-ons counts once, `lossesToday`; `TALON_DAY_LOSSES` 2, `TALON_DAY_STOP=off`) stop every automatic order until midnight ET (`checkDayStop` on the 5-min tick: open trades are still managed and watched; A.R.A. tells him once, resting limits are cancelled). His own "start trading" lifts it for the rest of the day (two more losses stop it again). Orders refused by a switch don't send "order rejected" alerts (`isBlockMessage`). `[TRADING_STATUS]` shows all three. `node server/scripts/test-switches.js`.

**Hand-offs are teammate to teammate** (owner, 2026-11-26: "I have them in a chat on Telegram so I can see when they talk to each other, but it sounds like they think they're talking to me"). Every relayed persona's prompt ends with `talkingTo` (`personaRuntime.js`): the message is from that teammate, so it answers them by name, with Mr. Burrus in the third person. Its group post is labeled `→ A.R.A.: …` like the ask (`relayAnswered`). The exception is his own question passed on (`Mr. Burrus asks you: …`, `hisWords` in `groupChat.js`; `GROUP_FRAME` tells A.R.A. to write it that way): that one answers him.

**A.R.A. is professional with the team** (owner, 2026-11-26: "I want Ara to always talk to other personas professionally" / "that shouldn't affect how she talks to me"). `ARA_TEAM_TONE` (`server/personas.js`, mirrored in `src/personas/personas.js`; `test-desks.js` fails if they drift) is in her Telegram prompt, her relay prompt and the app's `buildSys`: every `[RELAY_TO]` she writes, every answer to a teammate and her group-chat lines to others are a chief of staff's (clear, direct, no flirting, pet names or emotion cues); `talkingTo` repeats it when she answers a teammate. With him she is unchanged: `ARA_VOICE` / `ARA_SCRIPT` are untouched.

**A worker's stops all go round the team** (2026-11-26: a Groq sign-up asked him for "the newest sign-in email" on its third stop). `runBrowse` handles each new stop the same way, up to `ASK_ROUNDS` (6): A.R.A. looks it up (`FIND_MAX` 4), else J.A.R.V.I.S. answers / the worker decides (twice). He hears only an `onlyHim` stop or one past those limits. A `goto` whose page didn't load now fails with the browser's error (`Page.navigate`'s `errorText` used to be ignored, so a dead one-time link was "opened" 7 times on a blank page), and a browser restarted after a crash tells the brain a one-time link used before it is probably spent. **"Try the sign up again" starts it** (`ownerGo`): a name or filler in front ("Jarvis, …"), "tell him to / have the worker …", and any "try … again" / "retry" / "one more time" count as his go; questions still don't.

**T.A.L.O.N.'s stop sticks until he says start** (owner, 2026-11-26: told A.R.A. to stop Talon, and hours later he traded again). There was no tag for it: the personas could only say "okay", `auto_trade` stayed on, and W.I.R.E.'s news trades never checked `auto_trade` at all. `[TRADING_OFF]` (T.A.L.O.N., A.R.A.; `server/talonSwitch.js`, the `trading` switch) sets `talon_halt` = 1 and `auto_trade` = 0 and cancels resting quick-scalp limits. `tlPlaceOrder` then refuses every automatic order (setups, add-ons, quick scalps, re-entries, news trades, Nasdaq). Only his hand orders (`[TRADE_ENTER]`, `manual: true`) pass. The 5-min tick still manages open positions (reconcile, `ensureStop`, break-even, close alerts, the watch) while off. `[TRADING_ON]` runs only on his own words saying start / resume / turn on (`ownerStarts`); flipping the app's Settings toggle doesn't lift the stop. `[TRADING_STATUS]`. `node server/scripts/test-switches.js`.

**Groq Whisper for every transcription, the app's mic included** (owner, 2026-11-26: "replace whisper with groq so I can talk again"). Server transcription (`stt` in `server/llm.js`: Telegram voice notes, clips, transcripts, raw edits) tries Groq's `whisper-large-v3-turbo` first and falls back to OpenAI (`[TRANSCRIBE_USAGE]` shows the split). The app's own mic still posts OpenAI's `whisper-1` to `/ai/openai/v1/audio/transcriptions`; `routes/ai.js` (`groqFirst`, `swapModel`) sends that request to Groq first with the model swapped inside the multipart body, and only falls through to OpenAI on no key, a refusal or a timeout, so this needs no APK. The key is `GROQ_API_KEY`, else `app_settings.groq_api_key`, set by `[GROQ_KEY: gsk_…]` (J.A.R.V.I.S., A.R.A.; checked against Groq's `/models` first, `saveGroqKey`). A browse worker whose result holds a `gsk_` key saves it the same way and masks it in the report. `node server/scripts/test-app-voice-groq.js`, `test-transcribe-usage.js`.

**The phone line between J.A.R.V.I.S. and his workers** (owner, 2026-11-26: workers worked alone, so a stuck one guessed or came to him). A code worker runs `node scripts/jarvis-tool.js '[ASK_JARVIS: question]'`. It reaches J.A.R.V.I.S.'s front desk (`askJarvis` in `server/workerTools.js` → `relayToPersona('jarvis', …)`, his plain model with every tag, never the engine) with the worker's task attached. He answers, pulling in A.R.A. or others with `[RELAY_TO]`, and the worker carries on (4-minute cap). Only `NEEDS_HIM:` items end up in the report. He talks to a running code worker with `[WORKER_MESSAGE: slot | text]` (`message` in `workers.js` → `sendToWorker`). The worker reads `[WORKER_INBOX]` after each plan step and follows it over the original task. A stuck browse worker asks him (after A.R.A.'s search) before deciding by itself. Each exchange is posted in the Empire group. `node server/scripts/test-worker-phone.js`.

**Agree first, then a worker** (owner, 2026-11-26: "instead of talking to find what we can do, Jarvis jumps and puts a worker on it when we didn't agree what the problem was"). `[WORKER_START]` runs at once only on his own message that is a clear go (`ownerGo` in `workers.js`: "go", "do it", "yes", "fix it", "put a worker on it", or an order that starts with a verb; never a relay, a wake-up or a resumed turn). A problem report or a question starts nothing: the tag becomes a Start card (`startGate`, tg_pending `worker_start`, run by `runPending` on his tap) and J.A.R.V.I.S. tells him what he thinks is wrong, with evidence, and how he'd fix it. A desk-timeout hand-off (`handToWorker`) on anything but a go is investigate-only ("Look into: …"; no code changed). Code-driven workers (auto-fix, feature requests, A.R.A. finds) don't use the tag. `node server/scripts/test-worker-gate.js`.

**Workers only come to him for what only he has** (owner, 2026-11-26). A browse worker that stops goes to A.R.A. first (`araFinds`); if she has nothing and the stop isn't `onlyHim` (a texted code, a phone or authenticator approval, his ID, face or card, a CAPTCHA, his OK before sending, posting, buying or deleting), it runs again told to decide it itself: a new password is typed as `{{NEWPASS}}`, made in code and saved to his Drive as `Login — <title>`; a choice takes the sensible default. **Emailed sign-in links:** when an email has a sign-in link, only a number labelled as a code counts as a code (`extractCode(…, { strict })` in `emailLinks.js`), and a page that asked for a link always gets the link. Before this, Groq's Stytch login email came back as "code 94129" (Stytch's ZIP in the footer) and the worker typed it into a box that didn't exist.

**A finished worker's work is never lost at the push** (2026-11-26: 4 of 18 runs pushed nothing). `worker.yml` retries the push 5 times (GitHub's `fatal error in commit_refs_rules` hit 3 runs that day). The job's token can't push `.github/workflows` changes, so those are held back and posted in the report as a patch while the rest is pushed. Anything still unpushed is saved as the run's `worker-bundle` artifact (30 days). The runner is on Node 22, and server deps fall back from `npm ci` to `npm install`, printing why if both fail. Code workers run J.A.R.V.I.S.'s command tags through `scripts/jarvis-tool.js` → `/worker-tools` (`server/workerTools.js`, per-worker masked token; acting tags become Confirm cards).

**Desk mode: every task goes to a worker** (owner, 2026-11-23: "all jarvis tasks should go to a bot … the only thing he should do is small things, pushing code, redeployment"). Enforced in code, not only in his prompt: his own engine runs with read-only tools (`READ_ONLY_TOOLS`, `DESK` in `jarvisEngine.js`) and each turn is capped at `JARVIS_DESK_MIN` (4) min; a turn past the cap is handed to a code worker with what he'd found (`handToWorker`, Telegram and app) and he says which worker has it. His own jobs: straight answers, quick looks, pushing code and redeploying. **Pushing:** `[WORKER_SHIP: id | all | branch]` (`ship` in `workers.js`) merges finished code workers' branches (or any branch) into main through GitHub; a conflict is reported and left alone; server files changed → redeploy a minute later (`by: 'ship'`); only on his own message saying push / ship / merge. **Redeploying:** `[REDEPLOY]` on his own ask (redeploy / deploy / push / go live) runs with no Confirm tap, 45 s later so the reply goes out first; otherwise it stays a tap card. `JARVIS_DESK=off` gives him the full workshop back. `node server/scripts/test-desk-mode.js`.

## Personas ask J.A.R.V.I.S. for what they're missing (`server/featureRequests.js`, `FEATURE_REQUESTS=off` to stop)

Owner's idea, 2026-11-22, after A.R.A. bluffed about his calendar and then the weather. The CAN'T DO IT RIGHT? clause of `INITIATIVE` (both copies) tells every persona: asked for something in its own lane without the tool or live data to answer it right, never guess; emit `[NEED_FEATURE: what it couldn't do | what he asked]` (another persona's lane → `[RELAY_TO]`; an existing tag → use it). On his own message only (Telegram `runInjections` at depth 0; the app's `commandHandler` only with `ownerText` → `POST /features/request`), the same persona's same ask not twice in 7 days (`similar`), at most `FEATURE_REQ_PER_DAY` (5) a day. It starts a code worker (`purpose: 'feature'`, on GitHub) told to build it the way the code already does it (model: A.R.A.'s `calendarBlock`). **Fully automatic** (owner: "they go straight to him, he does it, it gets put in the code and updates everything, then they come back to me"): the persona says one line; when the worker reports DONE with commits, `finish` opens the PR, squash-merges it and redeploys the server; on the way up `followUps()` runs that persona's turn on his original question with the new ability and sends it on its bot (`personaOutOfBand` in `routes/telegram.js`). This is a deliberate exception to his "wait for push" rule, for persona abilities only. A PR touching trading, money, auth, boot or the workflows (`GUARDED`) gets his one-tap Merge card instead, and the answer follows the tap (`onTapMerged`). App-only changes ship in the next APK and the persona says so; nothing built, or the build stopped → the persona comes back and says why. If the new code falls back at boot (`EMPIRE_FALLBACK_ERROR`), the follow-up says it is NOT live yet. A follow-up that fails to send is retried after 2 and 10 min and only marked `answered` once it went out (else `follow-up failed`). A filed request counts as the hand-off to J.A.R.V.I.S. for `promisedHandoffs` (server `sink.relayed`, app `sent`). State: `app_settings.feature_requests`. `node server/scripts/test-feature-requests.js`.

## Every persona knows the holidays (`server/holidays.js`, mirrored in `src/services/holidays.js`)

Owner, 2026-11-26 (Thanksgiving): "she just sees my calendar stuff. Today is Thanksgiving, so she should know it's Thanksgiving. Maybe say happy Thanksgiving. All personas should know holidays." Pure code, no API: US federal holidays (and the observed weekday when one lands on a weekend), Easter / Good Friday, Mother's and Father's Day, Valentine's, St. Patrick's, Halloween, Black Friday, Cyber Monday, Christmas Eve, New Year's Eve, Kwanzaa, the clock changes, the stock market's closed and early-close days, and where Intl has the calendars (the server always; a phone may not) Hanukkah, Ramadan and both Eids. `holidayLine()` sits right after THE CURRENT MOMENT in every persona's Telegram prompt, relay prompt and the app's `buildSys`: today's holiday (wish him a happy one the first time they talk that day, once) and the next 21 days. `node server/scripts/test-holidays.js` (fails if the copies drift).

## A.R.A. always sees the weather (`weatherBlock`, `server/personaRuntime.js`; mirrored in `buildSys`)

Owner's complaint, 2026-11-22: she answered weather questions without looking. Every A.R.A. turn now carries the live Open-Meteo forecast for his home (`weatherLive` in `server/morningBrief.js`: now, the next 24 hours by the hour, the next 7 days; server cache 15 min; `weather_place` setting, default Waldorf, MD), with the rule to answer weather questions from it only. Another city → `[WEATHER: city, ST]` on Telegram. The app gets it from `GET /weather/live` (`liveWeather` in `src/services/clipScan.js`, 4 s timeout).

## Nothing dies in silence (`server/loud.js`)

His standing rule ("How Mr. Burrus Works", 2026-11-22): if anything dies, A.R.A. tells him. `tellAra(key, text)` is the last resort for code whose own message to him failed: A.R.A.'s bot as plain text (no voice), a phone push if Telegram is down, never throws, the same `key` at most once per 30 min. Used when a build request's follow-up fails all three tries, a worker's report can't be sent, an auto-fix message can't go out or can't start, an auto-fix is skipped after A.R.A. said one was coming, and (push only) when the memory guard's own report fails. New code that sends him something should fall back to it. `node server/scripts/test-loud.js`.

## Telegram "reply to message" (`repliedTo`, `server/routes/telegram.js`)

Owner's ask, 2026-11-22: when notifications land in between, he replies to the message he means. Every persona's turn now starts with `[HE IS REPLYING TO … from <time> ET: "…"]` when his message is a Telegram reply: the message's text or caption; a voice note, photo or anything without text is matched to the nearest saved message (±5 min) in that persona's `tg_messages`; his highlighted part (Telegram's quote) is named; in the group, another bot's message is named by its bot. It rides in front of his text, so it's saved in the history too. The app's own chat is unchanged. `node server/scripts/test-reply-context.js`.


## Live progress for every long job (`server/jobProgress.js`, `JOBS=off` to stop)

Owner's ask, 2026-11-22: what workers show (percent bar, current step, the strip chip, the Telegram board) now covers every long job a persona runs. `start(persona, title, steps)` → id, `step(id, label)` (the steps before it are done; a label not in the list is added), `note(id, text)`, `plan(id, names, doneCount)` (replace the list), `done(id, result)`, `fail(id, reason)`, and `run(persona, title, steps, fn)` which wraps a function (a throw fails the job and is rethrown). **Percent is real**: steps done / steps, held at 95 until the job ends, 100 only on success (no steps yet → `null`, "planning"). A failed job keeps its last number and its reason, and logs `jobs failed: <persona name> <title>: <reason>` so the sentinel sees it. State is `app_settings.jobs`: running jobs plus the last 50 finished (`KEEP`), so they survive a restart; a job still "running" at boot was cut off by it and is failed (and logged) then. Workers are untouched and keep their own tracking (`server/workers.js`).

Wired in: R.O.G.U.E.'s clip scan (`clipScan`, which auto clips use too, titled "Auto clip: …"; steps download audio → transcribe → pick moments → then a download-section / render / upload step per clip), raw edits and `[STYLE_LEARN]` (`rawEdit.js`), `[TRANSCRIBE]`, `[DEEP_RESEARCH]` (`runDeepResearch`), the website desk builds (`siteDesk.buildOne`), `[SITE_LOGIN]` / re-logins (`siteLogins.signIn`) and a persona's direct `[BROWSE]` (`browseTag`, fed by the browser brain's `onPlan`; a worker's browse still runs as a worker, not twice). New long jobs should use it too.

**Resumable (owner, 2026-11-23: nothing stops quietly, every persona picks up where it left off):** `start` / `run` take a `resume` (`{ kind, args, to }`) stored in the job's `app_settings.jobs` entry: `clip_scan` (url, focus, title), `raw_edit` (link, notes, profile), `style_learn`, `transcribe` (url, persona), `deep_research` (topic, persona). At boot `recover()` (`index.js`, 60 s after listen, once the server is healthy) restarts each job the restart cut off, **once**, through `RESUMERS` (the same background entry points that deliver the result as usual: `scanInBackground`, `transcribeInBackground`, `resumeEdit`, `resumeStyleLearn`, `runDeepResearch`), and A.R.A. tells him first as text (`loud.tellAra`): whose job, what, how far it got, that it's resuming. The rerun carries `attempts` 1; a job cut off again, one with nothing saved, or `JOB_RESUME=off` is only reported (`jobs failed: …` for the sentinel), never retried. A job being resumed logs a plain `jobs:` line at load instead of `jobs failed`. **Redeploy courtesy:** `requestRedeploy`'s receipt and `[WORKER_SHIP]`'s receipt list the persona jobs running and whether they resume (`runningJobsNote` / `runningLines`). `node server/scripts/test-job-progress.js`.

**Cancel (owner, 2026-11-23: "If I say cancel, it needs to get canceled … it better only cancel what I say to cancel"):** every job has a cancel handle (`server/jobProgress.js`). `[JOBS]` (J.A.R.V.I.S., A.R.A., R.O.G.U.E.) lists every running persona job live (id, persona, title, step, minutes). `[JOB_CANCEL: id or the job's own words]` cancels **exactly one**: an exact id (`7`, `#7`, `job-7`), or words that all appear in one and only one running job's title. Words matching several → **nothing** is cancelled and the matches are listed; matching none → "nothing running matched"; a persona's name alone never picks a job. `[JOB_CANCEL: all]` only runs when his own message that turn literally says "cancel all" / "cancel everything" (checked on `asked`, like `WORKER_SHIP`; not from relays or wake-ups); otherwise refused. The receipt names each job cancelled and lists every other running job as untouched. A cancel aborts the job's `AbortController` (`signal(id)`), SIGKILLs every child process spawned inside the job's async chain (hooked once on `ChildProcess.prototype.spawn` with `AsyncLocalStorage`, so yt-dlp, ffmpeg, the chat replay, Chrome all die however a module imported `spawn`; one spawned after the cancel dies on arrival), runs the job's `onCancel` cleanups at once (temp/checkpoint folders removed, locks released: clipScan's `running`, transcribe's counter, a persona's Chrome), and marks it `cancelled`, not failed (no `jobs failed` line, no sentinel alert, no "didn't work" message). `step()` / `checkpoint()` throw `JobCancelled` so work stops at the next step; callers rethrow it (`isCancel`, `asCancel`) instead of treating it as a render failure. A `cancelled` job is never resumed after a restart. Covers clip scans (and auto clips), raw edits, `STYLE_LEARN`, `TRANSCRIBE`, deep research, website builds, sign-ins and a persona's direct `[BROWSE]`; workers keep `[WORKER_STOP]`. **Nothing cancels automatically:** a `CLIP_SCAN` while one runs is refused with a receipt naming the running job (id, title, minutes) so the persona can ask him whether to cancel that one; auto clips just wait. `node server/scripts/test-job-cancel.js`.

Shown where workers show: `GET /jobs` (same item shape as `GET /workers`, plus `kind: 'job'`, `persona`, `personaName`, ids `job-N`), read by `fetchWorkers` in `src/services/sentinel.js` alongside `/workers`, so `NudgeBar` shows one chip per job labeled with the persona's name. **One Telegram board**: the existing one in `server/workers.js` (`boardText` / `boardTick`) lists workers and persona jobs together, each job line prefixed with the persona's name, "Live jobs: N running" in the header; `jobProgress` kicks it through `workers.kick()`. `WORKER_TG_BOARD=off` stops it. `node server/scripts/test-job-progress.js`.

## His website: The Empire (`server/site-empire`, `server/routes/empireSite.js`)

Owner, 2026-11-23: "Welcome to The Empire" (his Canva website design) rebuilt as a real site at `/empire/` on the server, public. 39 static pages: on a computer laid out as in Canva, on a phone stacked. Media lives in the GitHub release `empire-site-media` (listed in `server/site-empire/media.json`), fetched once into `~/.empire-bin/site-media` (prewarmed 3 min after boot) so the repo tarball stays small. Every contact/apply/RSVP button and the newsletter post to `POST /empire/api/form` (honeypot, 6 per 10 min per IP): saved in the synced `site_leads` table and sent to him from A.R.A.'s bot at once, `loud.tellAra` if that fails; failures log as `empire site failed: …`. Edit the HTML directly; how it was built and how to add media: `server/site-empire/README.md`. `node server/scripts/test-empire-site.js`.

 **Emailed links and codes** (`server/emailLinks.js`, owner 2026-11-24, after A.R.A. found five "Your login request to Groq" emails and no link): `gmailBodyText` (`server/google.js`) used to prefer text/plain and strip every tag from HTML, href included; it now turns anchors into "text (url)" (`htmlToText`), decodes base64url with padding, and `gmailRead` appends a LINKS list. A `[READ_EMAIL: search]` also reads its newest match in full; `[READ_EMAIL_ID: id]` reads one. `waitForEmailAuth` is the one waiter: newest email from the site sent after the run reached its "check your email" screen, polled every 20 s up to 10 min, giving a 4-8 digit code (`extractCode`) or the sign-in link (`pickAuthLink`: login / sign in / verify / confirm / magic; unsubscribe and tracking skipped). Nothing in 10 min says so plainly (`NOT_ARRIVED`), never a `{{CODE}}`/`{{INFO}}` placeholder. `node server/scripts/test-email-links.js`.
