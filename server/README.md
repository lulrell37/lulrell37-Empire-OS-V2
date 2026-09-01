# Empire OS V2 — backend

Node + Express + Postgres. Does four things for the app:

| Route | Purpose |
| --- | --- |
| `POST /sync/push`, `GET /sync/pull` | cross-device sync (generic last-write-wins JSON row store) |
| `ANY /ai/<provider>/<path>` | transparent proxy to Anthropic / OpenAI / xAI / ElevenLabs with server-held keys |
| `POST /push/register` | register an Expo push token (used by the scheduled nudge sender, phase 4) |
| `POST /google/token` | stash the Google refresh token for future server-side Gmail/Calendar |
| `GET /health` | unauthenticated health check |

Everything except `/health` requires `Authorization: Bearer $SYNC_TOKEN`.

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
