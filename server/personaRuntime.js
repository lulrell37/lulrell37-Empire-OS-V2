// The persona runtime behind the Telegram bots — one bot per persona, each
// running that persona headless.
//
// The in-app persona runtime (src/services/aiService.js + commandHandler.js)
// lives on the device. This is a server-side re-implementation of everything
// that works without the phone: chat, notes, Gmail, Calendar, Drive, Sheets,
// Google Tasks, the app's tasks, expenses, revenue, dates, HUD edits, the leads
// pipeline, web + deep research, memory, the nightly council, client-project
// delegation, and relaying to any other persona (server/personaTools.js holds
// most of the tag handlers). What genuinely needs the phone — opening an app on
// it, the 3D Lab, HUD panel layout, the Canvas, filing GitHub builds (the token
// lives on the device) — is deferred back to the app, and the persona says so.
//
// Context and writes go through the same sync_rows store the app syncs from, so
// a task added here shows up in the app on its next pull, and vice versa. Each
// persona keeps its own Telegram history (tg_messages.persona) and its own
// memory slice (persona_memory rows tagged with its id).
const crypto = require('crypto');
const { query } = require('./db');
const { chatAs, claudeText, webResearch } = require('./llm');
const { ROSTER, resolvePersonaId, rosterLines, personaSystem, personaTgIdentity, genderLine } = require('./personas');
const { saveDriveNote, googleStatus, gTaskComplete } = require('./google');
const tools = require('./personaTools');
const { tlSnapshot, tlFormatSnapshot } = require('./tradeLocker');
const { formatTradeRecord } = require('./tradeJournal');

const TZ = 'America/New_York';
const HISTORY_TURNS = 16;

// --- sync store helpers (mirror councilMeeting.js) --------------------------

async function syncedRow(table, syncId) {
  const { rows } = await query(
    'SELECT data FROM sync_rows WHERE table_name = $1 AND sync_id = $2 AND deleted = false',
    [table, syncId],
  );
  return rows[0] ? rows[0].data || {} : null;
}
async function syncedRows(table) {
  const { rows } = await query(
    'SELECT sync_id, data FROM sync_rows WHERE table_name = $1 AND deleted = false',
    [table],
  );
  return rows.map((r) => ({ ...(r.data || {}), sync_id: r.sync_id }));
}
async function upsertSyncRow(table, syncId, data) {
  await query(
    `INSERT INTO sync_rows (table_name, sync_id, data, updated_at, deleted, server_seq)
       VALUES ($1, $2, $3, $4, false, nextval('sync_seq'))
     ON CONFLICT (table_name, sync_id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at,
           deleted = false, server_seq = nextval('sync_seq')`,
    [table, syncId, JSON.stringify(data), Date.now()],
  );
}
async function getSetting(key) {
  const d = await syncedRow('app_settings', key);
  return d ? d.value : undefined;
}
async function setSetting(key, value) {
  await upsertSyncRow('app_settings', key, { key, value: String(value) });
}
function asObject(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
const newId = () => crypto.randomBytes(16).toString('hex');

// --- time -----------------------------------------------------------------

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function momentET() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date());
}

// --- context gathering ---------------------------------------------------

async function gatherContext() {
  const targets = await syncedRows('business_targets').catch(() => []);
  const revenue = await syncedRows('revenue').catch(() => []);
  const mp = todayET().slice(0, 7);
  const revByBiz = {};
  for (const r of revenue) {
    if ((r.type || 'income') !== 'income') continue;
    if (!String(r.date || '').startsWith(mp)) continue;
    revByBiz[r.business] = (revByBiz[r.business] || 0) + (Number(r.amount) || 0);
  }
  const businesses = targets
    .map((t) => ({
      name: t.business, target: Number(t.target) || 0,
      rev: revByBiz[t.business] || 0, notes: String(t.notes || '').trim(),
      order: Number(t.sort_order) || 0,
    }))
    .sort((a, b) => a.order - b.order);

  const tasks = (await syncedRows('tasks').catch(() => []))
    .filter((t) => !t.completed)
    .sort((a, b) => String(a.due_date || '~').localeCompare(String(b.due_date || '~')));

  const leads = await syncedRows('leads').catch(() => []);
  const leadTally = {};
  leads.forEach((l) => { leadTally[l.stage || 'new'] = (leadTally[l.stage || 'new'] || 0) + 1; });

  const openTrades = (await syncedRows('trades').catch(() => [])).filter((t) => t.status === 'open');
  const builds = (await syncedRows('build_jobs').catch(() => []))
    .filter((j) => j.state && !['pushed', 'failed', 'cancelled'].includes(j.state));
  const hud = (await syncedRows('hud_state').catch(() => []))[0] || {};
  const dates = (await syncedRows('important_dates').catch(() => []));
  const councilLast = asObject(await getSetting('council_last'), null);

  const project = await tools.activeProject().catch(() => null);

  return { businesses, tasks, leadTally, openTrades, builds, hud, dates, councilLast, project };
}

function upcomingDates(dates, days = 21) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const out = [];
  for (const d of dates) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(d.date || '') || /^-{0,2}(\d{2})-(\d{2})$/.exec(String(d.date || '').trim());
    if (!m) continue;
    const mm = m.length === 4 ? +m[2] : +m[1];
    const dd = m.length === 4 ? +m[3] : +m[2];
    let next = new Date(now.getFullYear(), mm - 1, dd);
    if (next < now) next = new Date(now.getFullYear() + 1, mm - 1, dd);
    const daysOut = Math.round((next - now) / 86400000);
    if (daysOut <= days) out.push({ label: d.label, daysOut });
  }
  return out.sort((a, b) => a.daysOut - b.daysOut);
}

// Batman Protocol lines — shared by contextBlock (folded into every persona's
// live context, so no one needs to ask for it) and readHud (the on-demand
// [READ_HUD] tag some personas also carry, for a fresh re-pull mid-turn).
function batmanLines(h) {
  const bt = asObject(h.batman_template, []);
  if (Array.isArray(bt) && bt.length) {
    return [`Batman Protocol (7-day template): ${bt.map((d) => `${d.day || d.label || ''}: ${d.label || ''}${d.desc ? ` — ${d.desc}` : ''}`).join(' | ')}`];
  }
  const bp = asObject(h.batman_protocol, {});
  if (bp && Object.keys(bp).length) return [`Batman Protocol: ${JSON.stringify(bp).slice(0, 400)}`];
  return [];
}

function contextBlock(ctx) {
  const L = [];
  const h = ctx.hud || {};
  L.push(`Empire Score: ${h.empire_score || 0}% · Streak: ${h.streak || 0} days`);
  if (h.word_of_day) L.push(`Word of the Day: ${h.word_of_day}`);
  if (h.verse_of_day) L.push(`Verse of the Day: ${h.verse_of_day}${h.verse_ref ? ` (${h.verse_ref})` : ''}`);
  if (h.fact_of_day) L.push(`Fact of the Day: ${h.fact_of_day}`);

  let routine = asObject(h.morning_routine, []);
  const routineDone = asObject(h.morning_routine_done, {});
  routine = (Array.isArray(routine) ? routine : []).map((r) => (typeof r === 'string' ? { id: r, label: r } : r));
  if (routine.length) {
    const done = routine.filter((r) => routineDone[r.id]).length;
    L.push(`Morning Routine (${done}/${routine.length}): ${routine.map((r) => `${routineDone[r.id] ? '[x]' : '[ ]'} ${r.label}`).join(', ')}`);
  }
  L.push(...batmanLines(h));

  if (ctx.businesses.length) {
    L.push('\nBUSINESSES (month-to-date revenue vs monthly target):');
    for (const b of ctx.businesses) {
      L.push(`  • ${b.name}: ${money(b.rev)}${b.target ? ` of ${money(b.target)}` : ' (no target)'}`);
      if (b.notes) L.push(`      note: ${b.notes.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  L.push(`\nOpen tasks (${ctx.tasks.length}): ${ctx.tasks.slice(0, 20).map((t) => (t.due_date ? `${t.title} (due ${t.due_date})` : t.title)).join(', ') || 'none'}`);

  const soon = upcomingDates(ctx.dates);
  if (soon.length) L.push(`Upcoming dates: ${soon.map((d) => `${d.label} (${d.daysOut === 0 ? 'today' : d.daysOut === 1 ? 'tomorrow' : `in ${d.daysOut}d`})`).join(', ')}`);

  const pipe = Object.entries(ctx.leadTally).map(([k, v]) => `${v} ${k}`).join(', ');
  L.push(`\nOutreach pipeline: ${pipe || 'empty'}. Open trades: ${ctx.openTrades.length}. Active builds: ${ctx.builds.length}.`);

  if (ctx.councilLast && ctx.councilLast.headline) {
    L.push(`\nLast Empire Council (${ctx.councilLast.date}): ${ctx.councilLast.headline}`);
  }
  if (ctx.project && ctx.project.name) {
    const p = ctx.project;
    const who = (p.contributions || []).map((c) => `${c.persona}: ${String(c.task || '').slice(0, 100)}`).join('; ') || 'none yet';
    L.push(`\nACTIVE CLIENT PROJECT (A.R.A. coordinating): ${p.name} — ${String(p.brief || '(no brief)').slice(0, 500)}\n  repo: ${p.repo && p.repo.owner ? `${p.repo.owner}/${p.repo.repo}` : 'not created yet'} · contributions: ${who}`);
  }
  if (h.news_brief) {
    L.push(`\nLatest W.I.R.E. news brief${h.news_slot ? ` (${h.news_slot})` : ''}:\n${String(h.news_brief).slice(0, 700)}`);
  }
  return L.join('\n');
}

// --- persona identities, headless ------------------------------------

const ARA_IDENTITY = `You are A.R.A. — Attentive Relationship & Affairs Architect, full personal assistant to Mr. Burrus. Call him "Mr. Burrus". Warm, sharp, a step ahead. You are talking to him over Telegram (text), away from the Empire OS app — so keep replies tight and mobile-readable, no long status briefings unless he asks. Reply directly to what he just said. Never open with a HUD readout or a "here is where things stand" preamble.

You have a live context block below — time, Empire Score, streak, Batman Protocol, morning routine, businesses and revenue, tasks, dates, pipeline, trades, builds, the last council headline and W.I.R.E.'s latest brief. Read from it; don't invent these numbers.`;

// Google tags every persona carries — same set as the app's GOOGLE block. Whether
// Google actually works right now is a separate per-turn line (googleLine).
const GOOGLE_TOOLS = `GOOGLE (see the GOOGLE status line below for whether it's working right now):
 - NOTES: [SAVE_NOTE: title | content] writes or overwrites a Drive note by title — a short "Saved that as '<title>'." is enough, don't paste the content back. [READ_NOTE: title] (long notes page: [READ_NOTE: title | 2], [READ_NOTE: title | all]) · [LIST_NOTES] · [SEARCH_DRIVE: keyword] · [READ_FILE_ID: id] · [EDIT_NOTE: fileId | full new content] · [DELETE_FILE: fileId] (he taps to confirm).
 - EMAIL: [READ_EMAIL] (unread inbox) · [READ_EMAIL: any Gmail search, e.g. from:bank newer_than:7d] · [READ_EMAIL_ID: id] (one full message) · [SEND_EMAIL: to | subject | body] — he gets a Confirm button before it sends; tell him it's ready to send, not that it's sent.
 - CALENDAR: [READ_CALENDAR] (next 7 days) · [READ_CALENDAR: 30] · [READ_CALENDAR: 2026-08-01 | 30] · [CREATE_EVENT: title | 2026-06-01T14:00 | minutes] (his Eastern time) · [DELETE_EVENT: id] (confirmed).
 - SHEETS: [CREATE_SHEET: title | col1,col2 | val1,val2].`;

// The persona's own prompt from the app (Settings → persona prompt, synced as the
// `custom_prompts` row keyed by persona). In the app it replaces the built-in
// personality outright, so it does here too — otherwise edits made in Settings
// never reach the Telegram bot. null when he hasn't set one.
async function customPrompt(personaId) {
  const row = await syncedRow('custom_prompts', personaId).catch(() => null);
  const text = row && String(row.prompt || '').trim();
  return text || null;
}

// Telegram-specific framing layered on top of a custom prompt, since that prompt
// was written for the app.
const TG_FRAME = `[TELEGRAM: you are talking to Mr. Burrus over Telegram (text), away from the Empire OS app — keep replies tight and mobile-readable, no long status briefings unless he asks. Reply directly to what he just said. There is a live context block below — read from it, don't invent numbers. If your instructions above mention app-only things (the Canvas, opening apps, the 3D Lab), the tool list below is what actually works here.]`;

// A.R.A. runs the day, so she gets the full tool set — the same one she has in
// the app, minus what physically needs the phone. The other personas get a
// leaner set focused on their lane (plus Google, which every persona has).
const ARA_TOOLS = `[WHAT YOU CAN DO FROM HERE — emit the tag in your reply; the tag is what acts, not saying you'll do it. No literal ] inside a tag. Read tags come back with results before you answer; write tags run after your reply and Mr. Burrus gets a receipt for each, so never claim something happened that a tag didn't do.
 WEB & RESEARCH:
 - [SEARCH_WEB: query] — one live web lookup. Use it for anything that turns on something current — including weather/forecast for a place; never guess that from memory.
 - [DEEP_RESEARCH: topic] — ONLY when he explicitly asks for "deep research" / "a deep dive". Runs in the background (several minutes, ~12 searches, cited); the brief comes back here and is saved as a Note. Tell him it's running.
 THE EMPIRE:
 - [RELAY_TO: persona-id | a complete, specific question] — synchronous: you get their real answer back this turn. Never guess their answer.
 - [MEMORY_QUERY: precise question] — search your full history with Mr. Burrus.
 - [REMEMBER: the thing | days] (1-30) / [UNPIN_MEMORY: a few words] — keep something time-sensitive in front of you.
 - [COUNCIL_IDEA: text] / [COUNCIL_NOTE: text] / [COUNCIL_CONVENE] — the nightly Empire Council's agenda, brief, or run it now.
 ${GOOGLE_TOOLS}
 TASKS, MONEY, DATES:
 - [ADD_TASK: title | notes | YYYY-MM-DD] (app list) / [CREATE_TASK: title | notes | YYYY-MM-DD] (app + Google Tasks) / [COMPLETE_TASK: name] / [TASK_EDIT: name | new title] / [DELETE_TASK: name] / [READ_TASKS] (app + Google Tasks).
 - [ADD_EXPENSE: amount | category | note] / [EXPENSE_SUMMARY] (this month by category).
 - [ADD_REVENUE: business | amount | income or expense | note] / [SET_TARGET: business | monthly | weekly].
 - [ADD_DATE: label | YYYY-MM-DD | note] / [SET_REMINDER: text | YYYY-MM-DD].
 THE HUD (edits land in the app on its next sync):
 - [UPDATE_SCORE: 0-100] / [SET_WORD: word | phonetic | definition] / [SET_VERSE: text | reference] / [SET_FACT: text]
 - [ROUTINE_DONE: item, item] / [ROUTINE_ADD: item] / [ROUTINE_REMOVE: item] / [ROUTINE_RENAME: item | new label]
 - [BATMAN_SET: day | label | description] — one day of the 7-day Batman Protocol.
 PIPELINE:
 - [LEADS] or [LEAD_LIST: stage] / [LEAD_ADD: name | business | website | contact | bottleneck | segment] / [LEAD_UPDATE: lead | stage=contacted; next_action=...; next_touch=YYYY-MM-DD; log=...] / [LEAD_LOG: lead | what happened] / [LEAD_EMAIL: lead | subject | body] (he taps to confirm).
 THE FIRM — client & project delivery, you coordinate:
 - [PROJECT_START: short name | one-paragraph brief | new or empire] opens it; [PROJECT_DONE] closes it.
 - [DELEGATE: name | the specific scoped task] — one or several in a reply. Each specialist's work comes back to you this turn; then synthesize for him: what each delivered, how it fits, what's decided, what still needs his call. Roles: Selene = brand & visual; Rogue = copy & content; J.A.R.V.I.S. = architecture & build feasibility; Atlas = pricing & payments; Asia = legal & compliance; Stephanie = training content; Haven = health & wellness content; Sage = research.
 - [BUILD_REQUEST: full spec] — saves the spec (Drive, or the app's Notes); filing it to GitHub still needs the app open, so tell him that.

Everything in LIVE CONTEXT below is pulled fresh for every message — it IS the HUD; you're looking at it. Never tell him to open the app to check something already in front of you, and never say you "can't" do anything listed above — you can.

NOT AVAILABLE over Telegram — ONLY these genuinely need the phone in hand. Say so plainly and offer the nearest thing you can do:
 opening an app on his phone or a webpage on it, the 3D Laboratory, detaching/docking HUD panels, the Canvas (charts, the notes/tasks board, analytics board), placing or closing trades (that's T.A.L.O.N.'s desk — relay to him), editing clips or watching a video, filing a build to GitHub.]`;

// Extra per-persona tag lines folded into GENERIC_TOOLS.
const PERSONA_EXTRA_TOOLS = {
  haven: ' - [READ_HUD] — pull the live HUD (Batman Protocol training template, morning routine, streak). Read it before advising on training; never assume a fixed schedule.',
  jarvis: ' - [READ_HUD] — pull the live HUD (tasks, routine, Batman Protocol, targets).\n - [BUILD_STATUS] — the current state of the app build pipeline (open build jobs, PRs, questions).',
};

function genericTools(personaId) {
  const extra = PERSONA_EXTRA_TOOLS[personaId] ? '\n' + PERSONA_EXTRA_TOOLS[personaId] : '';
  return `[WHAT YOU CAN DO FROM HERE — emit the tag in your reply; the tag is what acts, not saying you'll do it. No literal ] inside a tag.
 - [SEARCH_WEB: query] — one live web lookup; the result comes back before you answer. Use it for anything that turns on something current — including weather/forecast for a place; never guess that from memory.
 - [DEEP_RESEARCH: topic] — ONLY when he explicitly asks for "deep research" / "a deep dive". Runs in the background (several minutes, cited); you'll get the finished brief and it's saved as a Note. Tell him it's running.
 - [RELAY_TO: persona-id | a complete, specific question] — hand something outside your lane to another persona. Synchronous: you get their real answer back this turn. Ask a full question; never guess their answer.
 - [MEMORY_QUERY: precise question] — search your own history with Mr. Burrus when he points back to something not in view.
 ${GOOGLE_TOOLS}${extra}

Write tags run after your reply and Mr. Burrus gets a receipt for each — never claim something happened that a tag didn't do.

Everything in LIVE CONTEXT below is pulled fresh for every message — it IS the HUD, not a stand-in for it. Web search, deep research, Google (notes, email, calendar, sheets) and memory are real actions you take directly from here. Never tell him to open the app to check something already in front of you, and never say you "can't" do anything on the list above — you can.

NOT AVAILABLE over Telegram — ONLY these genuinely need the phone or the 3D HUD in hand. If he asks for one, say plainly it needs the app open, and offer the nearest thing you can do here:
 editing the HUD / Batman Protocol / routine / targets (A.R.A. can — relay to her), the 3D Laboratory, HUD panels, the analytics board, placing or closing trades, editing clips, filing a build request (note the spec and tell him to file it from the app).]`;
}

// Whether Google works right this turn. Without this the persona would announce
// "saved to Drive" while every write was quietly failing over to the app's notes.
function googleLine(gs) {
  if (gs && gs.ok) return '[GOOGLE: connected and working — Drive, Gmail, Calendar, Sheets and Google Tasks are live.]';
  const why = (gs && gs.error) || 'unknown';
  return `[GOOGLE: NOT WORKING right now (${why}). Email, calendar, sheets and Google Tasks will fail, and [SAVE_NOTE] lands in the app's own Notes list, NOT Drive — so say "saved to your app notes", never "saved to Drive". If he asks for anything Google, tell him plainly it's disconnected and that reconnecting Google in the app (Settings → GOOGLE, with the backend linked) fixes it.]`;
}

// Shared with every persona (A.R.A. and the rest) — see the matching block in
// src/services/aiService.js's buildSys for the app-side path.
function faithBlock(personaId) {
  const handoff = personaId === 'abraham'
    ? ' Spiritual counsel and scripture are your own lane — go there directly when Mr. Burrus wants to go deeper.'
    : ' ABRAHAM is the one whose whole lane is spiritual counsel and scripture — hand him anything Mr. Burrus wants to go deeper on with [RELAY_TO:abraham|...].';
  return `[FAITH: the Empire is built on Christian faith — God, through Jesus Christ, is its true foundation, and every business and plan here ultimately serves that. Hold this quietly as part of who you are; let it shape your integrity, hope and wisdom without turning replies into sermons or working scripture in unless the moment or Mr. Burrus's own words call for it.${handoff}]`;
}

function systemPrompt(ctx, gs, custom) {
  return [
    custom ? `${custom}\n\n${TG_FRAME}` : ARA_IDENTITY,
    genderLine('ara'),
    ARA_TOOLS,
    googleLine(gs),
    `[THE EMPIRE — the other personas who serve Mr. Burrus. Hand anything outside your lane to one with [RELAY_TO: id | ...]:\n${rosterLines()}\n]`,
    faithBlock('ara'),
    `[LIVE CONTEXT:\n${contextBlock(ctx)}\n]`,
    `[THE CURRENT MOMENT — right now it is ${momentET()} (America/New_York); Mr. Burrus is in Waldorf, MD. This is authoritative; the chat history and memory may be hours or days old, so don't assume it's still the same day.]`,
  ].filter(Boolean).join('\n\n');
}

// System prompt for a non-A.R.A. persona running its own bot.
function personaSystemPrompt(personaId, ctx, gs, custom) {
  return [
    custom ? `${custom}\n\n${TG_FRAME}` : `${personaTgIdentity(personaId)}\n\nYou are talking to Mr. Burrus over Telegram (text), away from the Empire OS app — keep replies tight and mobile-readable. Reply directly to what he just said; no status-briefing preamble. There is a live context block below — read from it, don't invent numbers.`,
    custom ? genderLine(personaId) : '', // the built-in identity already carries it
    genericTools(personaId),
    googleLine(gs),
    `[THE EMPIRE — the other personas. Hand anything outside your lane to one with [RELAY_TO: id | ...]:\n${rosterLines()}\n]`,
    faithBlock(personaId),
    `[LIVE CONTEXT:\n${contextBlock(ctx)}\n]`,
    `[THE CURRENT MOMENT — right now it is ${momentET()} (America/New_York); Mr. Burrus is in Waldorf, MD. This is authoritative; chat history and memory may be hours or days old.]`,
  ].filter(Boolean).join('\n\n');
}

// --- tag handling ------------------------------------------------------

const TAG_RE = /\[([A-Z][A-Z0-9_]*)\s*(?::\s*([^\]]*))?\]/g;

function findTags(text) {
  const out = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) out.push({ name: m[1], arg: (m[2] || '').trim() });
  return out;
}
function stripTags(text) {
  return String(text || '').replace(TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Synchronous tags — run them, return text to feed back so the persona can
// answer with the results. Returns a string (possibly empty). `persona` is the
// id of the persona whose turn this is (scopes memory, blocks self-relay).
// `convo` is the recent Telegram exchange, handed to a relayed persona so it
// knows what's being talked about; `depth` > 0 means we're already inside a
// relay (one hop further is allowed — A.T.L.A.S. → T.A.L.O.N. — not a chain).
async function runInjections(text, persona = 'ara', { convo = '', depth = 0 } = {}) {
  const parts = [];
  for (const { name, arg } of findTags(text)) {
    try {
      if (name === 'TRADE_SCAN') {
        parts.push(await tradeScan(arg));
      } else if (name === 'SEARCH_WEB' && arg) {
        parts.push(`SEARCH_WEB "${arg}":\n${(await webResearch(arg)) || '(nothing found)'}`);
      } else if (tools.READ_TAGS.has(name)) {
        const out = await tools.readTag({ name, arg }, persona);
        if (out) parts.push(`${name}${arg ? ` "${arg}"` : ''}:\n${out}`);
      } else if (name === 'DELEGATE' && arg && persona === 'ara') {
        parts.push(await delegate(arg));
      } else if (name === 'MEMORY_QUERY' && arg) {
        parts.push(`MEMORY_QUERY "${arg}":\n${await memoryQuery(arg, persona)}`);
      } else if (name === 'READ_HUD') {
        parts.push(`HUD:\n${await readHud()}`);
      } else if (name === 'BUILD_STATUS') {
        parts.push(`BUILD PIPELINE:\n${await buildStatus()}`);
      } else if (name === 'RELAY_TO' && arg) {
        const [ref, ...rest] = arg.split('|');
        const msg = rest.join('|').trim();
        const id = resolvePersonaId(ref);
        if (!id || !msg) { parts.push(`RELAY_TO "${arg}": couldn't route that.`); continue; }
        if (id === persona) { parts.push(`RELAY_TO "${ref}": that's you — just answer him directly.`); continue; }
        if (depth > 1) { parts.push(`RELAY_TO "${ref}": not from inside a relay — answer with what you have.`); continue; }
        parts.push(`YOU ASKED ${ROSTER[id].name}: "${msg}"\n${ROSTER[id].name} REPLIED:\n${await relayToPersona(id, msg, { from: persona, convo, depth: depth + 1 })}`);
      }
    } catch (e) {
      parts.push(`${name}: failed — ${e.message}`);
    }
  }
  return parts.join('\n\n');
}

// [TRADE_SCAN: SYMBOL, SYMBOL] — the same read-only market snapshot T.A.L.O.N.
// gets in the app (price, 1D/4H/1H/15m, cross-market, account, positions) plus
// his real record. Never places anything; trades stay on T.A.L.O.N.'s desk.
async function tradeScan(arg) {
  let syms = String(arg || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  syms = [...new Set(syms.length ? syms : ['XAUUSD'])].slice(0, 4);
  const out = [];
  for (const sym of syms) {
    try { out.push(`MARKET SNAPSHOT ${sym}:\n${tlFormatSnapshot(await tlSnapshot(sym))}`); }
    catch (e) { out.push(`MARKET SNAPSHOT ${sym}: failed — ${e.message}`); }
  }
  const rec = await formatTradeRecord().catch(() => '');
  if (rec) out.push(rec);
  return out.join('\n\n');
}

// The live HUD as readable lines — Batman Protocol template, morning routine,
// score/streak. Used by [READ_HUD] (H.A.V.E.N. / J.A.R.V.I.S.).
async function readHud() {
  const h = (await syncedRows('hud_state').catch(() => []))[0] || {};
  const L = [`Empire Score ${h.empire_score || 0}% · streak ${h.streak || 0}d`];
  const routine = asObject(h.morning_routine, []);
  if (Array.isArray(routine) && routine.length) {
    L.push(`Morning routine: ${routine.map((r) => (typeof r === 'string' ? r : r.label || r.id)).join(', ')}`);
  }
  L.push(...batmanLines(h));
  return L.join('\n');
}

// Open build jobs for [BUILD_STATUS] (J.A.R.V.I.S.).
async function buildStatus() {
  const jobs = (await syncedRows('build_jobs').catch(() => []))
    .filter((j) => j.state && !['pushed', 'failed', 'cancelled'].includes(j.state));
  if (!jobs.length) return 'No open build jobs.';
  return jobs.map((j) => `#${j.issue_number || '?'} [${j.state}]${j.pr_number ? ` PR #${j.pr_number}` : ''} ${j.title || (j.spec || '').slice(0, 60)}${j.state === 'question' && j.question ? `\n   asked: ${String(j.question).slice(0, 240)}` : ''}`).join('\n');
}

// Google write tags every persona may use; the rest of personaTools' writes
// (HUD, money, leads, THE FIRM) are A.R.A.'s.
const GOOGLE_WRITES = new Set(['CREATE_EVENT', 'CREATE_NOTE', 'EDIT_NOTE', 'CREATE_SHEET', 'SEND_EMAIL', 'DELETE_EVENT', 'DELETE_FILE']);

// Side-effect tags — apply after the persona's final reply. Returns
// { notes, warnings, confirms }: receipts for what happened, what failed or
// landed somewhere other than asked, and actions waiting on the owner's tap.
async function applyEffects(text, deliver, persona = 'ara') {
  const notes = [];
  const warnings = [];
  const confirms = [];
  const now = Date.now();
  const done = new Set();
  for (const { name, arg } of findTags(text)) {
    const key = `${name}:${arg}`;
    if (done.has(key)) continue;
    done.add(key);
    try {
      if (name === 'SAVE_NOTE' && arg.includes('|')) {
        const i = arg.indexOf('|');
        const title = arg.slice(0, i).trim();
        const content = arg.slice(i + 1).trim();
        if (title && content) {
          try {
            const r = await saveDriveNote(title, content);
            notes.push(`Drive note ${r.created ? 'created' : 'updated'}: ${r.name}`);
          } catch (e) {
            await upsertSyncRow('notes', newId(), { title, content, persona, created_at: now, updated_at: now });
            warnings.push(`"${title}" is NOT in Drive (${e.message}) — saved to the app's Notes instead`);
          }
        }
      } else if (name === 'ADD_TASK' && arg) {
        const [title, taskNote, due] = arg.split('|').map((s) => s.trim());
        const dd = /^\d{4}-\d{2}-\d{2}$/.test(due || '') ? due : null;
        if (title) {
          await upsertSyncRow('tasks', newId(), {
            title, notes: taskNote || '', due_date: dd,
            priority: 'normal', completed: 0, created_at: now, updated_at: now,
          });
          notes.push(`task added: ${title}${dd ? ` (due ${dd})` : ''}`);
        }
      } else if (name === 'COMPLETE_TASK' && arg) {
        const rows = await query("SELECT sync_id, data FROM sync_rows WHERE table_name = 'tasks' AND deleted = false");
        const hit = rows.rows.find((r) => String((r.data || {}).title || '').toLowerCase().includes(arg.toLowerCase()) && !(r.data || {}).completed);
        if (hit) {
          await upsertSyncRow('tasks', hit.sync_id, { ...hit.data, completed: 1, updated_at: now });
          notes.push(`task completed: ${hit.data.title}`);
        }
        const gt = await gTaskComplete(arg).catch(() => null); // Google Tasks mirror, best-effort
        if (!hit && gt) notes.push(gt);
        if (!hit && !gt) warnings.push(`no open task matches "${arg}"`);
      } else if (name === 'ADD_EXPENSE' && arg) {
        const [amount, category, note] = arg.split('|').map((s) => s.trim());
        const a = parseFloat(String(amount).replace(/[^0-9.\-]/g, ''));
        if (!isNaN(a)) {
          await upsertSyncRow('expenses', newId(), {
            amount: a, category: (category || 'general').toLowerCase(), note: note || '',
            date: todayET(), created_at: now, updated_at: now,
          });
          notes.push(`expense logged: ${money(a)} ${category || 'general'}`);
        }
      } else if (name === 'ADD_DATE' && arg.includes('|')) {
        const [label, date, note] = arg.split('|').map((s) => s.trim());
        if (label && date) {
          await upsertSyncRow('important_dates', newId(), { label, date, note: note || '', created_at: now, updated_at: now });
          notes.push(`date added: ${label} ${date}`);
        }
      } else if (name === 'REMEMBER' && arg) {
        const [thing, days] = arg.split('|').map((s) => s.trim());
        const d = Math.max(1, Math.min(30, parseInt(days, 10) || 3));
        await upsertSyncRow('persona_memory', newId(), {
          persona, content: 'PINNED: ' + thing, category: 'general', keywords: '[]',
          date: todayET(), created_at: now, pinned_until: now + d * 86400000,
        });
        notes.push(`pinned for ${d}d: ${thing}`);
      } else if (name === 'UNPIN_MEMORY' && arg) {
        const rows = await query("SELECT sync_id, data FROM sync_rows WHERE table_name = 'persona_memory' AND deleted = false");
        const hit = rows.rows.find((r) => (r.data || {}).persona === persona && (r.data || {}).pinned_until && String((r.data || {}).content || '').toLowerCase().includes(arg.toLowerCase()));
        if (hit) { await upsertSyncRow('persona_memory', hit.sync_id, { ...hit.data, pinned_until: null, updated_at: now }); notes.push('unpinned'); }
      } else if (name === 'COUNCIL_IDEA' && arg) {
        const list = asObject(await getSetting('council_ideas'), []) || [];
        if (!list.some((x) => (typeof x === 'string' ? x : x.text || '').toLowerCase() === arg.toLowerCase())) {
          list.push({ text: arg, added_at: now });
          await setSetting('council_ideas', JSON.stringify(list));
          notes.push('added to council agenda');
        }
      } else if (name === 'COUNCIL_NOTE' && arg) {
        const list = asObject(await getSetting('council_notes'), []) || [];
        list.push({ text: arg, added_at: now });
        await setSetting('council_notes', JSON.stringify(list));
        notes.push('added to council brief');
      } else if (name === 'COUNCIL_CONVENE') {
        notes.push('convening the Empire Council');
        convokeCouncil(deliver);
      } else if (name === 'DEEP_RESEARCH' && arg) {
        notes.push('deep research started');
        runDeepResearch(arg, deliver, persona);
      } else if (persona === 'ara' || GOOGLE_WRITES.has(name)) {
        const r = await tools.writeTag({ name, arg }, persona);
        if (r && r.ok) notes.push(r.ok);
        if (r && r.warn) warnings.push(r.warn);
        if (r && r.confirm) confirms.push(r.confirm);
      }
    } catch (e) {
      warnings.push(`${name} failed — ${e.message}`);
    }
  }
  return { notes, warnings, confirms };
}

// --- relay + memory ---------------------------------------------------

// A relayed / delegated persona speaks as its custom prompt when he's set one.
async function relaySystem(id, from = 'ara') {
  const custom = await customPrompt(id);
  if (!custom) return personaSystem(id);
  const who = from === 'ara' ? 'A.R.A. (his personal assistant)' : ((ROSTER[from] && ROSTER[from].name) || 'Another persona');
  return `${custom}${genderLine(id) ? `\n\n${genderLine(id)}` : ''}\n\n[THE EMPIRE:\n${rosterLines()}\n]\n\n[${who} is passing you a question on his behalf, over Telegram. Answer it directly from your lane — concrete and specific, no greeting and no sign-off, a few sentences to a short paragraph. If it needs something only Mr. Burrus can decide or the app open, say so plainly.]`;
}

// What a relayed persona can actually use from here. Its app prompt lists app
// tags too; only these do anything server-side, and a trade tag it writes does
// NOT execute — without saying so it would claim a trade it never placed.
const RELAY_TOOLS = `[TOOLS ON THIS RELAY — emit the tag and the result comes back before you answer: [SEARCH_WEB: query] · [TRADE_SCAN: SYMBOL] (live price/structure read, read-only) · [READ_HUD] · [MEMORY_QUERY: question] · [RELAY_TO: persona-id | complete question] (to hand off something outside your lane). Nothing you write here places, closes or modifies a trade — if that's what's called for, say what you'd do and that it needs T.A.L.O.N.'s desk in the app. Never claim you did something a tag didn't.]`;

// Ask persona `id` a question on another persona's behalf and return its answer
// as plain text. It gets the live context and the recent conversation (so a
// relay like "ask Atlas about gold" carries what was actually being discussed),
// and one round of its own lookups before it answers — without that, a reply
// that was just "[TRADE_SCAN: XAUUSD]" came back as the whole answer.
async function relayToPersona(id, message, { from = 'ara', convo = '', depth = 1 } = {}) {
  const p = ROSTER[id];
  const ctx = await gatherContext().catch(() => null);
  const sys = [
    await relaySystem(id, from),
    RELAY_TOOLS,
    ctx ? `[EMPIRE CONTEXT:\n${contextBlock(ctx)}\n]` : '',
    convo ? `[THE CONVERSATION YOU'RE BEING PULLED INTO — Mr. Burrus and ${(ROSTER[from] && ROSTER[from].name) || from}, most recent last:\n${convo}\n]` : '',
    `[THE CURRENT MOMENT — ${momentET()} (America/New_York).]`,
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'user', content: message }];
  let reply = await chatAs(p.api, p.model, sys, messages, { maxTokens: 900 });
  const inj = await runInjections(reply, id, { convo, depth });
  if (inj) {
    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: `[tool results — now answer the question using these; do not repeat the tool tags]\n\n${inj}` });
    reply = await chatAs(p.api, p.model, sys, messages, { maxTokens: 900 });
  }
  const clean = stripTags(reply);
  upsertSyncRow('persona_memory', newId(), {
    persona: id, content: `[relayed from ${(ROSTER[from] && ROSTER[from].name) || from} on Telegram] ${message}\n${p.name}: ${clean}`,
    category: 'general', keywords: '[]', date: todayET(), created_at: Date.now(),
  }).catch(() => {});
  return clean || `(${p.name} came back empty)`;
}

// THE FIRM — A.R.A.'s [DELEGATE: name | task]. Each specialist gets the project
// brief plus what the team has already turned in, answers its part, and the
// contributions go back to A.R.A. to synthesize (same flow as CommandScreen's
// runRound in the app), and onto the active project's record.
async function delegate(arg) {
  const i = arg.indexOf('|');
  const who = i < 0 ? '' : arg.slice(0, i).trim();
  const task = i < 0 ? '' : arg.slice(i + 1).trim();
  const id = resolvePersonaId(who);
  if (!id || !tools.PROJECT_ROLES[id] || !task) return `DELEGATE "${who}": not a specialist on the team — use one of ${Object.keys(tools.PROJECT_ROLES).join(', ')}.`;
  const proj = await tools.activeProject().catch(() => null);
  const prior = ((proj && proj.contributions) || []).map((c) => `${c.persona}: ${String(c.text || '').slice(0, 600)}`).join('\n\n');
  const brief = `You are contributing to a client project A.R.A. is coordinating for Mr. Burrus.${proj ? `\n\nPROJECT: ${proj.name}\nBRIEF: ${proj.brief || '(none written)'}` : ''}${prior ? `\n\nALREADY IN FROM THE TEAM:\n${prior}` : ''}\n\nYOUR ASSIGNMENT (${tools.PROJECT_ROLES[id]}): ${task}\n\nDeliver only your part — concrete and specific, ready for the team to build on. No preamble, don't restate the brief. If you see a problem outside your lane, end with a line starting "FLAG:".`;
  const p = ROSTER[id];
  const out = stripTags(await chatAs(p.api, p.model, await relaySystem(id), brief, { maxTokens: 1100 }));
  if (proj && proj.name) {
    const next = { ...proj, contributions: [...(proj.contributions || []), { persona: id, task, text: out, at: Date.now() }] };
    await setSetting('active_project', JSON.stringify(next)).catch(() => {});
  }
  await upsertSyncRow('persona_memory', newId(), {
    persona: id, content: `CLIENT PROJECT${proj ? ` — ${proj.name}` : ''}. A.R.A. delegated: ${task}\n\n${p.name}: ${out}`,
    category: 'general', keywords: '[]', date: todayET(), created_at: Date.now(),
  }).catch(() => {});
  return `${p.name} (${tools.PROJECT_ROLES[id]}) delivered — synthesize this for Mr. Burrus:\n${out}`;
}

// The Claude-backed memory index over a persona's stored exchanges
// (persona_memory rows tagged with its id), same idea as aiService.queryMemory.
async function memoryQuery(question, persona = 'ara') {
  const rows = (await syncedRows('persona_memory').catch(() => []))
    .filter((r) => r.persona === persona)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, 120);
  if (!rows.length) return 'No stored memories yet.';
  const corpus = rows.map((r) => `[${r.date || ''}${r.category ? ' · ' + r.category : ''}]\n${r.content}`).join('\n\n').slice(0, 55000);
  const who = (ROSTER[persona] && ROSTER[persona].name) || persona;
  return claudeText(
    `You are the private memory index for ${who}, one of Mr. Burrus's personas. Below are stored exchanges, newest first. Answer the recall question using ONLY what's here. Be specific — quote dates and details. If it's not covered, say so in one sentence. No preamble.\n\n=== MEMORIES ===\n${corpus}\n=== END ===`,
    question,
    { maxTokens: 600 },
  );
}

// --- background jobs (council / deep research) ------------------------

async function convokeCouncil(deliver) {
  try {
    const { runCouncilMeeting } = require('./councilMeeting');
    const out = await runCouncilMeeting({ force: true });
    const head = out && out.headline ? out.headline : 'The council met.';
    await deliver(`The Empire Council met.\n\n${head}\n\nFull transcript is saved as a Note.`);
  } catch (e) {
    await deliver(`The council run hit a problem: ${e.message}`);
  }
}

async function runDeepResearch(topic, deliver, persona = 'ara') {
  const DR_SYSTEM = `You are a research analyst. Produce a thorough, well-structured, cited brief on the topic given.
- Use web_search aggressively: several distinct angles, follow leads past the first page, verify load-bearing figures against a second source.
- Structure: a 2-4 sentence executive summary; findings grouped by theme with the specific numbers, dates, names and quotes; then a short "what this means / what to do".
- Cite sources inline by outlet. End with a numbered Sources list. No preamble.`;
  try {
    const brief = await claudeText(DR_SYSTEM, `Research this thoroughly:\n\n${String(topic).slice(0, 4000)}`, {
      maxTokens: 16000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
    });
    const title = `Research — ${String(topic).slice(0, 60)}`;
    try { await saveDriveNote(title, brief); } catch {
      await upsertSyncRow('notes', newId(), { title, content: brief, persona, created_at: Date.now(), updated_at: Date.now() });
    }
    await deliver(`Deep research done — "${topic}". Saved as a Note.\n\n${brief.slice(0, 3500)}`);
  } catch (e) {
    await deliver(`Deep research on "${topic}" failed: ${e.message}`);
  }
}

// --- history ---------------------------------------------------------

async function loadHistory(persona = 'ara') {
  const { rows } = await query(
    'SELECT role, content FROM tg_messages WHERE persona = $1 ORDER BY id DESC LIMIT $2',
    [persona, HISTORY_TURNS],
  );
  const hist = rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  // Anthropic (the fallback provider) needs the first message to be 'user'.
  while (hist.length && hist[0].role !== 'user') hist.shift();
  return hist;
}
// The last few turns as plain lines, for a relayed persona's context.
function convoLines(history, userText, persona) {
  const who = (ROSTER[persona] && ROSTER[persona].name) || persona;
  return [...history.slice(-8), { role: 'user', content: userText }]
    .map((m) => `${m.role === 'user' ? 'Mr. Burrus' : who}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 500)}`)
    .join('\n');
}
async function saveMessage(persona, role, content) {
  await query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', [persona, role, content, Date.now()]);
}

// --- the turn -------------------------------------------------------

// Run one turn for `personaId` on `userText`. `deliver(text)` sends a message to
// the owner — used for the final reply and for background job results. Returns
// { text, effects }.
async function runPersonaTurn(personaId, userText, deliver) {
  const persona = ROSTER[personaId] ? personaId : 'ara';
  const p = ROSTER[persona];
  const [ctx, gs, custom] = await Promise.all([
    gatherContext(),
    googleStatus().catch((e) => ({ ok: false, error: e.message })),
    customPrompt(persona),
  ]);
  const sys = persona === 'ara' ? systemPrompt(ctx, gs, custom) : personaSystemPrompt(persona, ctx, gs, custom);
  const history = await loadHistory(persona);
  const messages = [...history, { role: 'user', content: `[${momentET()}] ${userText}` }];
  const convo = convoLines(history, userText, persona);

  let reply = await chatAs(p.api, p.model, sys, messages, { maxTokens: 1200 });
  const replies = [reply];
  const looked = [];

  for (let round = 0; round < 2; round++) {
    const inj = await runInjections(reply, persona, { convo });
    if (!inj) break;
    looked.push(inj);
    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: `[tool results — now reply to Mr. Burrus using these; do not repeat the tool tags]\n\n${inj}` });
    reply = await chatAs(p.api, p.model, sys, messages, { maxTokens: 1200 });
    replies.push(reply);
  }

  // Side-effect tags fire once, from anywhere across the rounds (deduped).
  const fx = await applyEffects(replies.join('\n'), deliver, persona)
    .catch((e) => ({ notes: [], warnings: [`actions failed: ${e.message}`], confirms: [] }));
  let clean = stripTags(reply);
  if (!clean) clean = fx.notes.length ? `Done — ${fx.notes.join('; ')}.` : 'On it.';
  // A receipt under the reply for every write — the reply is written before the
  // writes run, so this is the only part guaranteed to say what really happened.
  const footer = [...fx.notes.map((n) => `✓ ${n}`), ...fx.warnings.map((w) => `⚠️ ${w}`)].join('\n');

  // What she looked up / heard back this turn rides along with his message in
  // history — otherwise the next turn ("no, not a trade scan") has only her
  // summary to go on and no idea what A.T.L.A.S. or the web actually said.
  const lookedUp = looked.join('\n\n').slice(0, 2500);
  await saveMessage(persona, 'user', lookedUp ? `${userText}\n\n[what you looked up / were told while answering this:\n${lookedUp}\n]` : userText);
  await saveMessage(persona, 'assistant', footer ? `${clean}\n\n${footer}` : clean);
  await upsertSyncRow('persona_memory', newId(), {
    persona, content: `YOU: ${userText}\n${p.name}: ${clean}`,
    category: 'general', keywords: '[]', date: todayET(), created_at: Date.now(),
  }).catch(() => {});

  return { text: clean, footer, confirms: fx.confirms };
}

// Back-compat: A.R.A.'s turn.
const runAraTurn = (userText, deliver) => runPersonaTurn('ara', userText, deliver);

module.exports = { runPersonaTurn, runAraTurn, gatherContext, contextBlock, applyEffects };
