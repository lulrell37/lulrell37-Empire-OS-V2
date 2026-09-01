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
