require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const auth = require('./auth');
const { runNudgeCycle } = require('./pushSender');
const { runDailyBriefing } = require('./dailyBriefing');
const { runCouncilMeeting } = require('./councilMeeting');

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
// run: it's ~20+ Claude calls, the daily cron is enough. Set COUNCIL=off to disable.
function startCouncilCron() {
  if (process.env.COUNCIL === 'off') return console.log('council cron disabled (COUNCIL=off)');
  if (!process.env.ANTHROPIC_API_KEY) return console.log('council cron off (no ANTHROPIC_API_KEY)');
  cron.schedule('0 5 * * *', () => {
    runCouncilMeeting()
      .then((r) => console.log('council meeting:', JSON.stringify(r)))
      .catch((e) => console.error('council meeting failed:', e.message));
  }, { timezone: 'America/New_York' });
  console.log('council cron scheduled (05:00 ET)');
}
