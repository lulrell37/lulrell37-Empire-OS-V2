// [BROWSE] from the app: J.A.R.V.I.S.'s and A.R.A.'s browser (server/browserAgent.js)
// runs here, on the server, and takes minutes — so the app starts a job and polls.
//   POST /browse { persona, task, ownerText } -> { id }
//   GET  /browse/:id -> { status: 'running' | 'done' | 'failed', text }
// The screenshot of the last page goes to him on Telegram (the persona's bot,
// else A.R.A.'s), since the app's chat shows text.
const express = require('express');
const crypto = require('crypto');

const r = express.Router();
const jobs = new Map();

function sweep() {
  const cut = Date.now() - 60 * 60e3;
  for (const [id, j] of jobs) if (j.at < cut) jobs.delete(id);
}

async function sendShot(persona, media) {
  if (!media || !media.length) return;
  try {
    const telegram = require('../telegram');
    const bot = (telegram.botFor(persona) && telegram.botFor(persona).isConfigured()) ? telegram.botFor(persona) : telegram.botFor('ara');
    if (!bot || !bot.isConfigured()) return;
    for (const m of media) await bot.sendFile(telegram.OWNER_ID, 'photo', m.buffer, { filename: m.filename, caption: m.caption });
  } catch (e) { console.error('browse screenshot send failed:', e.message); }
}

r.post('/', (req, res) => {
  const { persona = '', task = '', ownerText = '' } = req.body || {};
  const b = require('../browserAgent');
  if (!b.BROWSE_PERSONAS.has(String(persona))) return res.status(403).json({ error: "the browser is J.A.R.V.I.S.'s and A.R.A.'s only" });
  if (!String(task).trim()) return res.status(400).json({ error: 'needs a task' });
  sweep();
  const id = crypto.randomBytes(8).toString('hex');
  const job = { status: 'running', text: '', at: Date.now() };
  jobs.set(id, job);
  b.browseTag(String(persona), String(task), { ownerText: String(ownerText) })
    .then(async (out) => { job.status = 'done'; job.text = out.text; await sendShot(String(persona), out.media); })
    .catch((e) => { console.error('browse failed:', e.message); job.status = 'failed'; job.text = `BROWSE failed: ${e.message}`; });
  res.status(202).json({ id });
});

r.get('/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'no such browse job (the server may have restarted)' });
  res.json({ status: j.status, text: j.text });
});

module.exports = r;
