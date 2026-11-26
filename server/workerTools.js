// A code worker on its GitHub runner using J.A.R.V.I.S.'s command tags (owner, 2026-11-23:
// "workers are him with no limitations"). POST /worker-tools/:id takes the text of one or
// more tags and runs them through the same code his Telegram turn uses (runInjections and
// applyEffects in personaRuntime.js) as persona `jarvis`, returning the receipts as text.
//
// Auth: a per-worker token (app_settings.worker_tool_grants, the same shape as the Drive
// file grants in workers.js) handed out in the worker-run dispatch payload, masked in the
// job, never in the public issue, expiring after WORKER_TOOLS_H (12) hours or when the
// worker ends (revoke).
//
// Safety: a tag that sends, posts, buys, deletes, trades, merges, ships or redeploys never
// runs directly. It becomes a tg_pending Confirm card on J.A.R.V.I.S.'s bot (the tags whose
// own code already proposes one, like SEND_EMAIL / DELETE_FILE / BUILD_MERGE / REDEPLOY, use
// that card; the rest use the generic `worker_tag` kind, run by runConfirmed on his tap).
// Everything else runs at once. Every call is logged with the worker id.
const crypto = require('crypto');

let deps = null;
const d = () => deps || {};
const sync = () => d().sync || require('./syncStore');
const TTL_MS = () => (Number(process.env.WORKER_TOOLS_H) || 12) * 3600e3;
const GRANTS = 'worker_tool_grants';
const LOG = 'worker_tool_log';

// Tags that act in the world and have no confirm of their own: they get the generic card.
const GATED = new Set([
  'WORKER_SHIP', 'SITE_APPROVE', 'SITE_DROP', 'SITE_REVISE', 'SITE_DESK',
  'TRADE_ENTER', 'TRADE_CLOSE', 'MOVE_STOP', 'MOVE_TP', 'TRADE_ACCOUNT',
  'SEND_PHOTO', 'SEND_IMAGE', 'SEND_FILE', 'SEND_DOCUMENT', 'SEND_VIDEO', 'SEND_AUDIO', 'SEND_LOCATION',
  'GENERATE_IMAGE', 'DIAGRAM', 'CHART', 'TRADE_CHART',
  'AUTO_CLIP', 'AUTO_CLIP_OFF', 'AUTO_CLIP_TOPIC',
]);
// Tags whose own code already creates a Confirm card (writeTag's propose); they run as-is.
const SELF_CONFIRMED = new Set(['SEND_EMAIL', 'LEAD_EMAIL', 'DELETE_EVENT', 'DELETE_FILE', 'BUILD_REQUEST', 'BUILD_MERGE', 'REDEPLOY']);

const tagText = ({ name, arg }) => `[${name}${arg ? `: ${arg}` : ''}]`;

async function readGrants() {
  try { return JSON.parse(await sync().getSetting(GRANTS, '{}')) || {}; } catch { return {}; }
}
async function grantTools(w) {
  const token = crypto.randomBytes(24).toString('hex');
  const grants = await readGrants();
  const now = Date.now();
  for (const [k, g] of Object.entries(grants)) if (!g || g.exp < now) delete grants[k];
  grants[token] = { worker: String(w.id), exp: now + TTL_MS() };
  await sync().setSetting(GRANTS, JSON.stringify(grants));
  return token;
}
async function toolGrant(token, id) {
  if (!token || id == null) return null;
  const g = (await readGrants())[token];
  return g && g.exp > Date.now() && String(g.worker) === String(id) ? g : null;
}
async function revoke(id) {
  const grants = await readGrants();
  let n = 0;
  for (const [k, g] of Object.entries(grants)) if (!g || String(g.worker) === String(id) || g.exp < Date.now()) { delete grants[k]; n++; }
  if (n) await sync().setSetting(GRANTS, JSON.stringify(grants));
}

async function logCall(id, tags, outcome) {
  const line = `${new Date().toISOString()} worker #${id}: ${tags.map((t) => t.name).join(', ') || '(none)'} — ${outcome}`;
  console.log(`worker-tools: ${line}`);
  try {
    let list = [];
    try { list = JSON.parse(await sync().getSetting(LOG, '[]')) || []; } catch { list = []; }
    list.push(line);
    await sync().setSetting(LOG, JSON.stringify(list.slice(-200)));
  } catch (e) { console.error(`workers failed: tool log: ${e.message}`); }
}

// The Confirm card, on J.A.R.V.I.S.'s bot (A.R.A.'s if his isn't set up).
async function sendCard(c) {
  if (d().sendCard) return d().sendCard(c);
  const tg = require('./telegram');
  const bot = tg.botFor('jarvis') && tg.botFor('jarvis').isConfigured() ? tg.botFor('jarvis') : tg.botFor('ara');
  if (!bot || !bot.isConfigured() || !tg.OWNER_ID) throw new Error('no Telegram bot to send the Confirm card on');
  await bot.sendMessage(tg.OWNER_ID, `${c.label}?\n\n${c.detail}`, {
    log: false,
    reply_markup: { inline_keyboard: [[{ text: '✅ Confirm', callback_data: `ok:${c.id}` }, { text: '✖ Cancel', callback_data: `no:${c.id}` }]] },
  });
}

async function propose(workerId, tag) {
  const id = sync().newId().slice(0, 12);
  const persona = /^(TRADE_|MOVE_STOP|MOVE_TP)/.test(tag.name) ? 'talon' : 'jarvis';
  const label = `Worker #${workerId} wants to run ${tag.name}`;
  const detail = `${tagText(tag).slice(0, 1500)}\n\nAsked by J.A.R.V.I.S.'s worker #${workerId}. Nothing happens until you tap Confirm.`;
  await (d().query || require('./db').query)(
    'INSERT INTO tg_pending (id, persona, kind, label, detail, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, persona, 'worker_tag', label, detail, JSON.stringify({ name: tag.name, arg: tag.arg, persona, worker: workerId }), Date.now()],
  );
  return { id, label, detail };
}

// Run tag text for worker `id`. Returns the receipts as one string.
async function run(id, text) {
  const pr = d().runtime || require('./personaRuntime');
  const tags = pr.findTags(String(text || ''));
  if (!tags.length) {
    await logCall(id, tags, 'no tags');
    return 'No command tags found. Write them like [SAVE_NOTE: title | content] or [SEARCH_WEB: query].';
  }
  const out = [];
  const confirms = [];
  const direct = [];
  for (const t of tags) {
    // The phone line (owner, 2026-11-26): a worker asks J.A.R.V.I.S. mid-job, or reads
    // what he sent it, instead of guessing or stopping for Mr. Burrus.
    if (t.name === 'ASK_JARVIS') { out.push(await askJarvis(id, t.arg).catch((e) => `ASK_JARVIS failed: ${e.message}. Carry on with your best judgment.`)); continue; }
    if (t.name === 'WORKER_INBOX') { out.push(await readInbox(id).catch((e) => `WORKER_INBOX failed: ${e.message}`)); continue; }
    if (GATED.has(t.name)) {
      try {
        const c = await propose(id, t);
        confirms.push(c);
        out.push(`⏳ ${t.name}: waiting on Mr. Burrus's Confirm tap (card sent on J.A.R.V.I.S.'s bot). It has NOT run.`);
      } catch (e) { out.push(`⚠️ ${t.name}: could not create the Confirm card — ${e.message}. Not run.`); }
    } else direct.push(t);
  }
  if (direct.length) {
    const body = direct.map(tagText).join('\n');
    const sink = { notes: [], warnings: [], confirms: [], media: [], deliver: async () => {} };
    // Inside a job (depth 1): hand-offs go through without the top-level gate, as KEEP MOVING says.
    const looked = await pr.runInjections(body, 'jarvis', { depth: 1, sink, asked: '', chain: ['jarvis'] }).catch((e) => `lookup failed: ${e.message}`);
    if (looked) out.push(looked);
    const fx = await pr.applyEffects(body, sink.deliver, 'jarvis', { ownerText: '' }).catch((e) => ({ notes: [], warnings: [`actions failed: ${e.message}`], confirms: [] }));
    for (const n of [...fx.notes, ...sink.notes]) out.push(`✓ ${n}`);
    for (const w of [...fx.warnings, ...sink.warnings]) out.push(`⚠️ ${w}`);
    for (const c of [...fx.confirms, ...sink.confirms]) { confirms.push(c); out.push(`⏳ waiting on Mr. Burrus's Confirm tap: ${c.label} (card sent on J.A.R.V.I.S.'s bot). It has NOT run.`); }
  }
  for (const c of confirms) {
    try { await sendCard(c); } catch (e) {
      console.error(`workers failed: tool confirm card for #${id}: ${e.message}`);
      require('./loud').tellAra(`worker-tool-card-${id}`, `Worker #${id} asked for something that needs your tap (${c.label}), but I couldn't send the card: ${e.message}`);
      out.push(`⚠️ the Confirm card for "${c.label}" could not be sent: ${e.message}`);
    }
  }
  await logCall(id, tags, `${direct.length} ran, ${confirms.length} waiting on a tap`);
  return out.join('\n\n') || '(nothing to report)';
}

// --- The phone line between J.A.R.V.I.S. and his workers --------------------------
// A worker's question goes to J.A.R.V.I.S.'s front desk (his plain model with all his
// tags, not the engine, so he's never tied up); he answers from what he knows, his
// tools, or by pulling in A.R.A. / another persona ([RELAY_TO], KEEP MOVING). Only
// what nobody on the team can give reaches Mr. Burrus. The exchange is posted in the
// Empire group and saved in J.A.R.V.I.S.'s memory like any relay.
const ASK_TIMEOUT_MS = 4 * 60e3;
async function askJarvis(id, question, { relay = null } = {}) {
  const q = String(question || '').trim();
  if (!q) return 'ASK_JARVIS: give the question, e.g. [ASK_JARVIS: which email should the Groq account use?]';
  const w = (await workerRow(id)) || {};
  const who = `worker ${w.slot || '?'} of 3 ("${w.title || `#${id}`}")`;
  const post = (from, text) => require('./groupChat').post(from, text).catch(() => {});
  post('jarvis', `🔧 ${who} → J.A.R.V.I.S.: ${q.slice(0, 400)}`);
  const msg = `[ONE OF YOUR OWN WORKERS — ${who} — IS ASKING YOU MID-JOB. You and your workers are one J.A.R.V.I.S.; answer it so it can carry on. Its task: ${String(w.task || '').slice(0, 1500)}]\n\nIts question: ${q}\n\nAnswer it directly and specifically. If the answer is in his email, notes or calendar, get it from A.R.A. with [RELAY_TO: ara | …]; if another persona owns it, ask them. Decide ordinary choices yourself (names, settings, defaults) the way he'd want. Only if it truly needs Mr. Burrus (a code texted to his phone, a phone approval, his ID or card, his OK to send / post / buy / delete) say exactly NEEDS_HIM: and what — never for anything else.`;
  const ask = relay || ((m) => (d().runtime || require('./personaRuntime')).relayToPersona('jarvis', m, { from: 'jarvis', depth: 1, chain: ['jarvis'] }));
  const answer = await Promise.race([
    ask(msg),
    new Promise((_, rej) => setTimeout(() => rej(new Error('J.A.R.V.I.S. took over 4 minutes')), ASK_TIMEOUT_MS)),
  ]);
  const text = String(answer || '').trim() || '(no answer)';
  post('jarvis', `🔧 J.A.R.V.I.S. → ${who}: ${text.slice(0, 600)}`);
  return `J.A.R.V.I.S. ANSWERS:\n${text}\n\n(Carry on with this. If it says NEEDS_HIM, finish everything else first, then end your report with that one question.)`;
}

async function workerRow(id) {
  try { return (d().workers || require('./workers')).get(id); } catch { return null; }
}

// Messages J.A.R.V.I.S. sent a running worker ([WORKER_MESSAGE] in workers.js), unread first.
const INBOX = 'worker_inbox';
async function readInbox(id) {
  let all = {};
  try { all = JSON.parse(await sync().getSetting(INBOX, '{}')) || {}; } catch { all = {}; }
  const box = all[id] || [];
  const unread = box.filter((m) => !m.read);
  if (!unread.length) return 'WORKER_INBOX: nothing new from J.A.R.V.I.S.';
  for (const m of box) m.read = true;
  all[id] = box.slice(-20);
  await sync().setSetting(INBOX, JSON.stringify(all));
  return `WORKER_INBOX — from J.A.R.V.I.S. (follow it; it overrides the original task where they differ):\n${unread.map((m) => `• ${new Date(m.at).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET: ${m.text}`).join('\n')}`;
}
async function sendToWorker(id, text) {
  let all = {};
  try { all = JSON.parse(await sync().getSetting(INBOX, '{}')) || {}; } catch { all = {}; }
  (all[id] = all[id] || []).push({ at: Date.now(), text: String(text).slice(0, 4000), read: false });
  all[id] = all[id].slice(-20);
  await sync().setSetting(INBOX, JSON.stringify(all));
}

// His tap on a worker_tag card (called from runPending in personaTools.js).
async function runConfirmed(pl) {
  const pr = d().runtime || require('./personaRuntime');
  const persona = pl.persona || 'jarvis';
  const body = tagText(pl);
  const media = require('./telegramMedia');
  if (media.MEDIA_TAGS.has(pl.name)) {
    const tg = require('./telegram');
    const bot = tg.botFor('jarvis') && tg.botFor('jarvis').isConfigured() ? tg.botFor('jarvis') : tg.botFor('ara');
    const items = media.mediaFromTags([{ name: pl.name, arg: pl.arg }]);
    const failed = await media.sendMedia(bot, tg.OWNER_ID, items);
    return failed.length ? `Not sent: ${failed.join('; ')}` : `${pl.name} sent.`;
  }
  const sink = { notes: [], warnings: [], confirms: [], media: [], deliver: async () => {} };
  // His tap is the owner's own yes, so the tags that need his message to say push/ship get it.
  const asked = 'ship it';
  const looked = await pr.runInjections(body, persona, { depth: 0, sink, asked, chain: [] });
  const fx = await pr.applyEffects(body, sink.deliver, persona, { ownerText: asked });
  return [looked, ...fx.notes, ...fx.warnings, ...sink.notes, ...sink.warnings].filter(Boolean).join('\n') || `${pl.name} ran.`;
}

// Express handler: POST /worker-tools/:id, body = raw text or JSON { tags }.
async function handler(req, res) {
  const id = String(req.params.id || '');
  try {
    if (!(await toolGrant(String(req.get('x-worker-token') || ''), id))) return res.status(403).json({ error: 'bad or expired token' });
    const text = typeof req.body === 'string' ? req.body : (req.body && (req.body.tags || req.body.text)) || '';
    if (!String(text).trim()) return res.status(400).json({ error: 'no tag text' });
    const receipts = await run(id, text);
    res.json({ ok: true, receipts });
  } catch (e) {
    console.error(`workers failed: tool call #${id}: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
}

module.exports = { askJarvis, readInbox, sendToWorker, grantTools, toolGrant, revoke, run, runConfirmed, handler, GATED, SELF_CONFIRMED, tagText, _setDeps: (x) => { deps = x; } };
