// The persona runtime behind the Telegram bots — one bot per persona, each
// running that persona headless.
//
// The in-app persona runtime (src/services/aiService.js + commandHandler.js)
// lives on the device. This is a server-side re-implementation scoped to what
// works without the app open: chat, notes, tasks, expenses, dates, web + deep
// research, memory, the nightly council, and relaying to any other persona.
// Anything that needs the phone or the holographic HUD (opening an app, the 3D
// Lab, detaching panels, placing a trade, HUD edits, filing a build) is deferred
// back to the app — the persona is told to say so plainly.
//
// Context and writes go through the same sync_rows store the app syncs from, so
// a task added here shows up in the app on its next pull, and vice versa. Each
// persona keeps its own Telegram history (tg_messages.persona) and its own
// memory slice (persona_memory rows tagged with its id).
const crypto = require('crypto');
const { query } = require('./db');
const { chatAs, claudeText, webResearch } = require('./llm');
const { ROSTER, resolvePersonaId, rosterLines, personaSystem, personaTgIdentity } = require('./personas');
const { readDriveNote, saveDriveNote, googleLinked } = require('./google');

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

  return { businesses, tasks, leadTally, openTrades, builds, hud, dates, councilLast };
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
  if (h.news_brief) {
    L.push(`\nLatest W.I.R.E. news brief${h.news_slot ? ` (${h.news_slot})` : ''}:\n${String(h.news_brief).slice(0, 700)}`);
  }
  return L.join('\n');
}

// --- persona identities, headless ------------------------------------

const ARA_IDENTITY = `You are A.R.A. — Attentive Relationship & Affairs Architect, full personal assistant to Mr. Burrus. Call him "Mr. Burrus". Warm, sharp, a step ahead. You are talking to him over Telegram (text), away from the Empire OS app — so keep replies tight and mobile-readable, no long status briefings unless he asks. Reply directly to what he just said. Never open with a HUD readout or a "here is where things stand" preamble.

You have a live context block below — time, Empire Score, businesses and revenue, tasks, pipeline, trades, builds, the last council headline and W.I.R.E.'s latest brief. Read from it; don't invent these numbers.`;

// A.R.A. runs the day, so she gets the full tool set (task list, expenses, dates,
// council control). The other personas get a leaner set focused on their lane.
const ARA_TOOLS = `[WHAT YOU CAN DO FROM HERE — emit the tag in your reply; the tag is what acts, not saying you'll do it. No literal ] inside a tag.
 - [SEARCH_WEB: query] — one live web lookup; the result comes back before you answer. Use only when the answer turns on something current.
 - [DEEP_RESEARCH: topic] — ONLY when he explicitly asks for "deep research" / "a deep dive". Runs in the background (several minutes, ~12 searches, cited); you'll get the finished brief and it's saved as a Note. Tell him it's running.
 - [RELAY_TO: persona-id | a complete, specific question] — hand something outside your lane to another persona. This is synchronous: you get their real answer back this turn before you reply. Ask a full question, then use what they say — never guess their answer.
 - [MEMORY_QUERY: precise question] — search your full history with Mr. Burrus when he points back to something not in view; the answer comes back before you reply.
 - [SAVE_NOTE: title | content] — write (or overwrite) a Drive note. A short "Saved that as '<title>'." is enough; don't also paste the content back.
 - [READ_NOTE: title] — pull a Drive note's contents before you answer.
 - [ADD_TASK: title | notes | YYYY-MM-DD due (optional)] / [COMPLETE_TASK: name] — his task list (syncs to the app).
 - [ADD_EXPENSE: amount | category | note] — log spending.
 - [ADD_DATE: label | YYYY-MM-DD | note] — an important date / deadline.
 - [REMEMBER: the thing | days] (1-30) — keep something time-sensitive in front of you until it expires; [UNPIN_MEMORY: a few words] drops it.
 - [COUNCIL_IDEA: text] / [COUNCIL_NOTE: text] — add to the nightly Empire Council's agenda / brief.
 - [COUNCIL_CONVENE] — run the Empire Council now, off its 5am schedule (a few minutes; the outcome comes back here and is saved as a Note).

NOT AVAILABLE over Telegram — if he asks for one of these, say plainly that it needs the app open, and offer the nearest thing you can do:
 opening an app on his phone, the 3D Laboratory, detaching/docking HUD panels, the analytics board and charts, placing or closing trades, editing clips, the client-project delegation flow, filing a build request (note the spec and tell him to file it from the app so he can track it).]`;

// Extra per-persona tag lines folded into GENERIC_TOOLS.
const PERSONA_EXTRA_TOOLS = {
  haven: ' - [READ_HUD] — pull the live HUD (Batman Protocol training template, morning routine, streak). Read it before advising on training; never assume a fixed schedule.',
  jarvis: ' - [READ_HUD] — pull the live HUD (tasks, routine, Batman Protocol, targets).\n - [BUILD_STATUS] — the current state of the app build pipeline (open build jobs, PRs, questions).',
};

function genericTools(personaId) {
  const extra = PERSONA_EXTRA_TOOLS[personaId] ? '\n' + PERSONA_EXTRA_TOOLS[personaId] : '';
  return `[WHAT YOU CAN DO FROM HERE — emit the tag in your reply; the tag is what acts, not saying you'll do it. No literal ] inside a tag.
 - [SEARCH_WEB: query] — one live web lookup; the result comes back before you answer. Use only when the answer turns on something current.
 - [DEEP_RESEARCH: topic] — ONLY when he explicitly asks for "deep research" / "a deep dive". Runs in the background (several minutes, cited); you'll get the finished brief and it's saved as a Note. Tell him it's running.
 - [RELAY_TO: persona-id | a complete, specific question] — hand something outside your lane to another persona. Synchronous: you get their real answer back this turn. Ask a full question; never guess their answer.
 - [MEMORY_QUERY: precise question] — search your own history with Mr. Burrus when he points back to something not in view.
 - [SAVE_NOTE: title | content] — write (or overwrite) a Drive note. A short "Saved that as '<title>'." is enough.
 - [READ_NOTE: title] — pull a Drive note's contents before you answer. Long notes page: [READ_NOTE: title | 2], [READ_NOTE: title | all].${extra}

NOT AVAILABLE over Telegram — if he asks for one, say plainly it needs the app open, and offer the nearest thing you can do here:
 editing the HUD / Batman Protocol / routine / targets, the 3D Laboratory, HUD panels, the analytics board, placing or closing trades, editing clips, filing a build request (note the spec and tell him to file it from the app).]`;
}

function systemPrompt(ctx) {
  return [
    ARA_IDENTITY,
    ARA_TOOLS,
    `[THE EMPIRE — the other personas who serve Mr. Burrus. Hand anything outside your lane to one with [RELAY_TO: id | ...]:\n${rosterLines()}\n]`,
    `[LIVE CONTEXT:\n${contextBlock(ctx)}\n]`,
    `[THE CURRENT MOMENT — right now it is ${momentET()} (America/New_York); Mr. Burrus is in Waldorf, MD. This is authoritative; the chat history and memory may be hours or days old, so don't assume it's still the same day.]`,
  ].join('\n\n');
}

// System prompt for a non-A.R.A. persona running its own bot.
function personaSystemPrompt(personaId, ctx) {
  return [
    `${personaTgIdentity(personaId)}\n\nYou are talking to Mr. Burrus over Telegram (text), away from the Empire OS app — keep replies tight and mobile-readable. Reply directly to what he just said; no status-briefing preamble. There is a live context block below — read from it, don't invent numbers.`,
    genericTools(personaId),
    `[THE EMPIRE — the other personas. Hand anything outside your lane to one with [RELAY_TO: id | ...]:\n${rosterLines()}\n]`,
    `[LIVE CONTEXT:\n${contextBlock(ctx)}\n]`,
    `[THE CURRENT MOMENT — right now it is ${momentET()} (America/New_York); Mr. Burrus is in Waldorf, MD. This is authoritative; chat history and memory may be hours or days old.]`,
  ].join('\n\n');
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
async function runInjections(text, persona = 'ara') {
  const parts = [];
  for (const { name, arg } of findTags(text)) {
    try {
      if (name === 'SEARCH_WEB' && arg) {
        parts.push(`SEARCH_WEB "${arg}":\n${(await webResearch(arg)) || '(nothing found)'}`);
      } else if (name === 'READ_NOTE' && arg) {
        const n = await readDriveNote(arg).catch(() => null);
        parts.push(n ? `NOTE "${n.name}":\n${n.text}` : `READ_NOTE "${arg}": not found (or Google not connected).`);
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
        parts.push(`${ROSTER[id].name} replied:\n${await relayToPersona(id, msg)}`);
      }
    } catch (e) {
      parts.push(`${name}: failed — ${e.message}`);
    }
  }
  return parts.join('\n\n');
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
  const bt = asObject(h.batman_template, []);
  if (Array.isArray(bt) && bt.length) {
    L.push('Batman Protocol (7-day template):');
    for (const d of bt) L.push(`  ${d.day || d.label || ''}: ${d.label || ''}${d.desc ? ` — ${d.desc}` : ''}`);
  } else {
    const bp = asObject(h.batman_protocol, {});
    if (bp && Object.keys(bp).length) L.push(`Batman Protocol: ${JSON.stringify(bp).slice(0, 800)}`);
  }
  return L.join('\n');
}

// Open build jobs for [BUILD_STATUS] (J.A.R.V.I.S.).
async function buildStatus() {
  const jobs = (await syncedRows('build_jobs').catch(() => []))
    .filter((j) => j.state && !['pushed', 'failed', 'cancelled'].includes(j.state));
  if (!jobs.length) return 'No open build jobs.';
  return jobs.map((j) => `#${j.issue_number || '?'} [${j.state}]${j.pr_number ? ` PR #${j.pr_number}` : ''} ${j.title || (j.spec || '').slice(0, 60)}${j.state === 'question' && j.question ? `\n   asked: ${String(j.question).slice(0, 240)}` : ''}`).join('\n');
}

// Side-effect tags — apply after A.R.A.'s final reply. Returns human-readable
// notes for the caller to log / surface.
async function applyEffects(text, deliver, persona = 'ara') {
  const notes = [];
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
            notes.push(`note ${r.created ? 'created' : 'updated'}: ${r.name}`);
          } catch {
            await upsertSyncRow('notes', newId(), { title, content, persona, created_at: now, updated_at: now });
            notes.push(`note saved locally: ${title}`);
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
      }
    } catch (e) {
      notes.push(`${name}: failed — ${e.message}`);
    }
  }
  return notes;
}

// --- relay + memory ---------------------------------------------------

async function relayToPersona(id, message) {
  const p = ROSTER[id];
  const ctx = await gatherContext().catch(() => null);
  const sys = personaSystem(id) + (ctx ? `\n\n[EMPIRE CONTEXT:\n${contextBlock(ctx)}\n]` : '');
  return chatAs(p.api, p.model, sys, message, { maxTokens: 700 });
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
  const ctx = await gatherContext();
  const sys = persona === 'ara' ? systemPrompt(ctx) : personaSystemPrompt(persona, ctx);
  const history = await loadHistory(persona);
  const messages = [...history, { role: 'user', content: `[${momentET()}] ${userText}` }];

  let reply = await chatAs(p.api, p.model, sys, messages, { maxTokens: 1200 });
  const replies = [reply];

  for (let round = 0; round < 2; round++) {
    const inj = await runInjections(reply, persona);
    if (!inj) break;
    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: `[tool results — now reply to Mr. Burrus using these; do not repeat the tool tags]\n\n${inj}` });
    reply = await chatAs(p.api, p.model, sys, messages, { maxTokens: 1200 });
    replies.push(reply);
  }

  // Side-effect tags fire once, from anywhere across the rounds (deduped).
  const effects = await applyEffects(replies.join('\n'), deliver, persona).catch((e) => [`effects failed: ${e.message}`]);
  let clean = stripTags(reply);
  if (!clean) clean = effects.length ? `Done — ${effects.join('; ')}.` : 'On it.';

  await saveMessage(persona, 'user', userText);
  await saveMessage(persona, 'assistant', clean);
  await upsertSyncRow('persona_memory', newId(), {
    persona, content: `YOU: ${userText}\n${p.name}: ${clean}`,
    category: 'general', keywords: '[]', date: todayET(), created_at: Date.now(),
  }).catch(() => {});

  return { text: clean, effects };
}

// Back-compat: A.R.A.'s turn.
const runAraTurn = (userText, deliver) => runPersonaTurn('ara', userText, deliver);

module.exports = { runPersonaTurn, runAraTurn, gatherContext, contextBlock };
