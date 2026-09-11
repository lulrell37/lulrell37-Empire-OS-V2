require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const auth = require('./auth');
const { runNudgeCycle } = require('./pushSender');
const { runDailyBriefing } = require('./dailyBriefing');
const { runCouncilMeeting, endCouncilLive } = require('./councilMeeting');
const { runScoutSignalCycle } = require('./autoScout');
const telegram = require('./telegram');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.get('/health', (req, res) => res.json({ ok: true, service: 'empire-os-backend', ts: Date.now() }));

// AI proxy: no body parser — the request body is streamed straight through.
app.use('/ai', auth, require('./routes/ai'));

// JSON APIs.
const json = express.json({ limit: '25mb' });
app.use('/sync', auth, json, require('./routes/sync'));
app.use('/push', auth, json, require('./routes/push'));
app.use('/google', auth, json, require('./routes/google'));
app.use('/council', auth, json, require('./routes/council'));

// Telegram bots — one headless front door per persona. Each webhook is guarded
// by its own persona-namespaced secret path + header + owner-id check (no bearer).
app.use('/telegram', express.json({ limit: '1mb' }), require('./routes/telegram'));

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  console.error('unhandled', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

const PORT = process.env.PORT || 3000;
db.init()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Empire OS backend listening on :${PORT}`));
    startNudgeCron();
    startDailyBriefingCron();
    startCouncilCron();
    startScoutSignalCron();
    registerTelegramWebhook();
  })
  .catch((e) => {
    console.error('DB init failed:', e.message);
    process.exit(1);
  });

// The scheduled nudge sender. Ticks every 30 minutes; each nudge's own time
// window + push_log keep it to one send per occurrence. Set NUDGES=off to
// disable (e.g. for a second instance or local dev).
function startNudgeCron() {
  if (process.env.NUDGES === 'off') return console.log('nudge cron disabled (NUDGES=off)');
  cron.schedule('*/30 * * * *', () => {
    runNudgeCycle()
      .then((r) => { if (r.sent.length) console.log('nudges sent:', r.sent.join(', ')); })
      .catch((e) => console.error('nudge cycle failed:', e.message));
  });
  console.log('nudge cron scheduled (every 30m)');
}

// Daily HUD content — Word + Fact (S.T.E.P.H.A.N.I.E.) and Verse (Abraham).
// 05:10 ET so it's ready before the owner's morning. Idempotent per day.
function startDailyBriefingCron() {
  if (process.env.DAILY_BRIEFING === 'off') return console.log('daily briefing cron disabled (DAILY_BRIEFING=off)');
  if (!process.env.ANTHROPIC_API_KEY) return console.log('daily briefing cron off (no ANTHROPIC_API_KEY)');
  cron.schedule('10 5 * * *', () => {
    runDailyBriefing()
      .then((r) => console.log('daily briefing:', JSON.stringify(r)))
      .catch((e) => console.error('daily briefing failed:', e.message));
  }, { timezone: 'America/New_York' });
  runDailyBriefing().then((r) => console.log('daily briefing (startup):', JSON.stringify(r))).catch(() => {});
  console.log('daily briefing cron scheduled (05:10 ET)');
}

// The nightly Empire Council — A.R.A. + the council discuss the businesses (with
// live web research) and set next steps. 05:00 ET, idempotent per day. No startup
// run: it's ~20+ Claude calls, the daily cron is enough.
// OFF by default (it's the biggest recurring spend on the account, and it needs
// the app synced to the backend to have anything to discuss). Set COUNCIL=on to
// bring it back.
function startCouncilCron() {
  if (process.env.COUNCIL !== 'on') return console.log('council cron disabled (set COUNCIL=on to enable)');
  if (!process.env.ANTHROPIC_API_KEY) return console.log('council cron off (no ANTHROPIC_API_KEY)');
  cron.schedule('0 5 * * *', () => {
    runCouncilMeeting()
      .then((r) => console.log('council meeting:', JSON.stringify(r)))
      .catch((e) => { console.error('council meeting failed:', e.message); endCouncilLive(e.message).catch(() => {}); });
  }, { timezone: 'America/New_York' });
  console.log('council cron scheduled (05:00 ET)');
}

// Server-side S.C.O.U.T. — buying-intent signal discovery. Walks one grid cell
// every SCOUT_INTERVAL_MIN minutes (default 30), writes warm leads into the sync
// store. OFF by default; set SCOUT_CRON=on. Needs ANTHROPIC_API_KEY (qualify)
// and at least one source key (ADZUNA_APP_ID/KEY, YELP_API_KEY).
function startScoutSignalCron() {
  if (process.env.SCOUT_CRON !== 'on') return console.log('scout signal cron disabled (set SCOUT_CRON=on to enable)');
  if (!process.env.ANTHROPIC_API_KEY) return console.log('scout signal cron off (no ANTHROPIC_API_KEY)');
  const mins = Math.min(55, Math.max(10, parseInt(process.env.SCOUT_INTERVAL_MIN || '30', 10) || 30));
  cron.schedule(`*/${mins} * * * *`, () => {
    runScoutSignalCycle()
      .then((r) => console.log('scout signal cycle:', JSON.stringify(r)))
      .catch((e) => console.error('scout signal cycle failed:', e.message));
  });
  console.log(`scout signal cron scheduled (every ${mins}m)`);
}

// Point every configured Telegram bot's webhook at this deployment on boot, so
// the bots keep working across redeploys without a manual step. Needs
// TELEGRAM_OWNER_ID + at least one TELEGRAM_BOT_TOKEN[_PERSONA] + PUBLIC_URL (the
// deployment's public https origin). Without PUBLIC_URL, register once by hand:
// POST /telegram/set-webhook { url }.
function registerTelegramWebhook() {
  if (!telegram.isConfigured()) return console.log('telegram bots disabled (set TELEGRAM_OWNER_ID + a TELEGRAM_BOT_TOKEN[_PERSONA])');
  const live = telegram.configuredBots().map((b) => b.personaId).join(', ');
  if (!process.env.PUBLIC_URL) return console.log(`telegram bots on (${live}) — set PUBLIC_URL to auto-register webhooks, or POST /telegram/set-webhook`);
  telegram.setWebhook(process.env.PUBLIC_URL)
    .then((rs) => console.log('telegram webhooks set:', rs.map((r) => r.error ? `${r.persona}:ERR ${r.error}` : r.persona).join(', ')))
    .catch((e) => console.error('telegram webhook registration failed:', e.message));
}
