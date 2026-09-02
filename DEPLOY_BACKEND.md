# Deploy the Empire OS backend — checklist

Generated 2026-09-02. Everything below was verified working from the workspace:
the server boots, connects to the database, applies its schema, and the auth
token works. The only remaining steps are Replit UI clicks.

## Your sync token (already generated — keep it secret)

```
CMjXTDim-YLXKsrGnalq65rZNrEPs7iT2W4NuLrPIoUA67gG
```

This goes in TWO places and must match exactly:
1. The deployment's Secrets, as `SYNC_TOKEN`
2. The app: Settings -> BACKEND -> SYNC TOKEN

## Step 1 — Database  ✅ ALREADY DONE

A Postgres database is already provisioned in this Repl (`DATABASE_URL` is set,
`PGDATABASE=heliumdb`). Replit passes it to the deployment automatically. The
schema (`server/schema.sql`) applies itself on every boot. Nothing to do.

## Step 2 — Open Deployments

Replit -> Tools -> Deployments (or the Deploy button, top right).

- Type: **Reserved VM** (NOT Autoscale — the server runs an always-on cron for
  nudges every 30 min and the 5:10am ET daily HUD briefing).
- Build command:  `cd server && npm ci`      (already set in `.replit`)
- Run command:    `cd server && npm start`   (already set in `.replit`)

## Step 3 — Deployment Secrets

Add these in the deployment's Secrets panel:

| Name                 | Value                                              | Required |
| -------------------- | -------------------------------------------------- | -------- |
| `SYNC_TOKEN`         | `CMjXTDim-YLXKsrGnalq65rZNrEPs7iT2W4NuLrPIoUA67gG` | YES      |
| `ANTHROPIC_API_KEY`  | your Anthropic key                                 | optional |
| `XAI_API_KEY`        | your xAI key                                       | optional |
| `OPENAI_API_KEY`     | your OpenAI key                                    | optional |
| `ELEVENLABS_API_KEY` | your ElevenLabs key                                | optional |

- `DATABASE_URL` is NOT listed — Replit injects it automatically.
- Only `SYNC_TOKEN` is needed to boot. The AI keys enable the AI proxy path and
  the auto-generated daily briefing; add them now or later.

## Step 4 — Deploy

Click Deploy. When it finishes, Replit shows the URL, e.g.
`https://empire-os-v2.replit.app` (or your custom domain).

## Step 5 — Verify

Open `https://<your-url>/health` in a browser. Expected:

```json
{"ok":true,"service":"empire-os-backend","ts":...}
```

## Step 6 — Connect the app

Empire OS -> Settings -> BACKEND:

- SERVER URL:  the `https://...replit.app` URL from Step 4
- SYNC TOKEN:  `CMjXTDim-YLXKsrGnalq65rZNrEPs7iT2W4NuLrPIoUA67gG`

Tap connect. The app pings `/health`, confirms it's a real Empire OS backend,
and saves both to the device keychain. Sync, push nudges, and the AI proxy
activate automatically from then on.

## Notes

- Pushing to `main` rebuilds the APK via GitHub Actions but does NOT redeploy
  the server. Redeploy the server from the Deployments panel, or turn on
  auto-deploy-on-push in the deployment settings.
- Push nudge delivery also needs Expo push credentials: run `eas credentials`
  once (Android -> FCM V1 service account key). Without it, tokens still
  register but pushes silently fail.
- To disable the crons on the deployment: set `NUDGES=off` and/or
  `DAILY_BRIEFING=off` in Secrets.
