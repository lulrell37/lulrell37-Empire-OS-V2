require('dotenv').config();
const express = require('express');
const db = require('./db');
const auth = require('./auth');

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
  })
  .catch((e) => {
    console.error('DB init failed:', e.message);
    process.exit(1);
  });
