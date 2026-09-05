# Empire OS V2 — backend

Node + Express + Postgres. Does four things for the app:

| Route | Purpose |
| --- | --- |
| `POST /sync/push`, `GET /sync/pull` | cross-device sync (generic last-write-wins JSON row store) |
| `ANY /ai/<provider>/<path>` | transparent proxy to Anthropic / OpenAI / xAI / ElevenLabs with server-held keys |
| `POST /push/register`, `POST /push/unregister` | add / remove an Expo push token for the scheduled nudge sender |
| `POST /push/run`, `POST /push/test` | run a nudge cycle now (`{"force":true}` skips the time windows + de-dupe) / send one test push |
| `POST /google/token` | stash the Google refresh token for future server-side Gmail/Calendar |
| `GET /health` | unauthenticated health check |

Everything except `/health` requires `Authorization: Bearer $SYNC_TOKEN`.

## Scheduled nudges

`pushSender.js` runs on an in-process cron (every 30 min) started from
`index.js`. Each tick reads the synced dataset out of `sync_rows`, computes the
nudges that apply at the current time in `America/New_York` — morning briefing
(7–10am), routine-behind (2–6pm), streak-at-risk (6–10pm), and build-pipeline
alerts (any time) — and pushes them to every row in `devices` via
`https://exp.host/--/api/v2/push/send`. `push_log` keeps each nudge to one send
per occurrence. Set `NUDGES=off` to disable the cron.

Delivery needs Expo's push credentials for the app: run `eas credentials` once
(Android → FCM V1 service account key) so `exp.host` can reach the device.
Without it tokens still register but pushes silently fail.

## Daily briefing

`dailyBriefing.js` runs at 05:10 ET (plus once at boot). Generates the HUD Word +
Fact + Verse of the day via Claude and writes them into `sync_rows`. Idempotent
per day. Needs `ANTHROPIC_API_KEY`; set `DAILY_BRIEFING=off` to disable.

## Nightly Empire Council

`councilMeeting.js` runs at **05:00 ET** every day (`node-cron`, no boot run).
A.R.A. + the council (everyone except Ghost, Talon, Rogue, Batman) hold a strategy
meeting on their own: it reads the current businesses + month-to-date revenue +
the owner's queued ideas (`app_settings` `council_ideas`) out of `sync_rows`,
pulls **live web research** on each business/idea via Claude's `web_search` tool,
runs a `COUNCIL_ROUNDS` (default 2) discussion, and A.R.A. writes the next steps.
Results land back in `sync_rows`: a `notes` row (`Empire Council — <date>`, the
full transcript), an `app_settings` digest `council_last` that A.R.A. surfaces
on "how's the empire", a pinned A.R.A. `persona_memory` row, and a
"The council met" push (de-duped in `push_log` as `council:<date>`). Idempotent
per day via `app_settings` `council_last_date`.

Each persona speaks on its **real provider** when that key is set on the server —
A.R.A. on Grok (`XAI_API_KEY`), S.E.L.E.N.E. on GPT-4o (`OPENAI_API_KEY`), N.O.V.A.
on Gemini (`GEMINI_API_KEY`), the rest on Claude — and falls back to
`claude-sonnet-5` for any persona whose key is missing (or on an API error /
empty reply). The web research always runs on Claude. Needs `ANTHROPIC_API_KEY`;
set `COUNCIL=off` to disable. Tunables: `COUNCIL_ROUNDS`, `COUNCIL_RESEARCH_MAX`
(default 8), `COUNCIL_SEARCH_MAX` (default 6). The persona roster is a distilled
copy of `src/personas/personas.js` kept in `councilMeeting.js`.

## Local dev

```sh
cd server
cp .env.example .env      # fill in DATABASE_URL + SYNC_TOKEN
npm install
npm start                 # -> http://localhost:3000
curl localhost:3000/health
```

## Deploy on Replit

1. Replit → **Deploy** → **Reserved VM**.
   - Build command: `cd server && npm ci`
   - Run command: `cd server && npm start`
   (The repo `.replit` already has this under `[deployment]`.)
2. Deployment **Secrets**: `SYNC_TOKEN` (long random string), `ANTHROPIC_API_KEY`,
   `XAI_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`.
   `DATABASE_URL` is injected automatically.
3. Open the app → Settings → **BACKEND**, paste the deployment URL and the same
   `SYNC_TOKEN`.

The schema (`schema.sql`) is applied automatically on every boot.
