// The nightly Empire Council, server side.
//
// Runs on a cron (see server/index.js) at 05:00 ET so a fresh strategy readout is
// waiting before the owner wakes up — and it runs whether or not the app was ever
// opened. Same machinery as server/dailyBriefing.js: read the synced dataset out
// of sync_rows, call Claude with the server-held key, write the results back into
// sync_rows where the app pulls them.
//
// What it does each run:
//   1. Reads the current businesses (HUD Business panel), month-to-date revenue,
//      the owner's queued ideas (app_settings `council_ideas`), and his
//      pre-meeting brief: the "Council Brief" Google Drive note (read via
//      server/google.js with the synced refresh token) plus any quick lines he
//      added in chat with [COUNCIL_NOTE] (app_settings `council_notes`). A.R.A.
//      reads the brief to the room to open the meeting; the Drive note is left
//      untouched, the chat quick-adds are cleared afterward.
//   2. Pulls LIVE web research on each business + idea — what's actually working
//      in that market right now — via Claude's web_search tool.
//   3. A.R.A. opens the meeting; the council (everyone except Andrew, Talon,
//      Rogue, Batman, Abraham, and the AI-influencer ops personas) discusses
//      over N rounds, each persona seeing the prior replies.
//   4. A.R.A. synthesises the council's read + recommendation + the decision
//      for Mr. Burrus, per business/idea. It's advice for him to act on, not a
//      to-do list the personas are working.
//   5. Persists: a Note (full transcript), an app_settings digest `council_last`
//      that A.R.A. surfaces on "how's the empire", a pinned A.R.A. memory, and a
//      push notification.
//
// Runs on its 5am cron, and also on demand: A.R.A. emits [COUNCIL_CONVENE] in
// chat -> the app hits POST /council/run -> runCouncilMeeting({ force: true }),
// which bypasses the once-a-day guard (and COUNCIL=off) and stamps the transcript
// note with the time so an off-schedule run doesn't overwrite the morning one.
//
// Disabled unless ANTHROPIC_API_KEY is set. Set COUNCIL=off to force off (a
// forced /council/run still goes through).
// Personas speak on their real provider when its key is set on the server
// (XAI_API_KEY for A.R.A., OPENAI_API_KEY for S.E.L.E.N.E., GEMINI_API_KEY for
// N.O.V.A.); anyone whose key is missing falls back to Claude. Research is Claude.
//
// The persona roster below is a distilled copy of src/personas/personas.js
// (that file ships in the APK and isn't reachable from here). Keep it in sync if
// a council persona's identity changes materially.
const crypto = require('crypto');
const { query } = require('./db');
const { pushCouncil } = require('./pushSender');
const { readDriveNote } = require('./google');

// The owner keeps a running brief for the council in a Google Drive note with
// this exact title. A.R.A. reads whatever's in it to the room at the top of each
// meeting; it's never modified from here. Rename it with COUNCIL_BRIEF_NOTE.
const BRIEF_NOTE_TITLE = process.env.COUNCIL_BRIEF_NOTE || 'Council Brief';

const TZ = 'America/New_York';
const CLAUDE_MODEL = 'claude-sonnet-5';
const ROUNDS = Math.max(1, Math.min(4, Number(process.env.COUNCIL_ROUNDS) || 2));
const RESEARCH_MAX = Math.max(1, Math.min(20, Number(process.env.COUNCIL_RESEARCH_MAX) || 8));
const SEARCH_MAX = Math.max(0, Math.min(20, Number(process.env.COUNCIL_SEARCH_MAX) || 6));
const WEB_SEARCH_TOOL = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

// Each council persona speaks on its OWN provider when that provider's key is set
// on the server (XAI_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) — otherwise it
// falls back to Claude. `api`/`model` mirror src/personas/personas.js.
// The live web research always runs on Claude (only Anthropic's web_search tool
// is wired here); ANTHROPIC_API_KEY is required for the feature regardless.
const PROVIDER = {
  anthropic: { base: 'https://api.anthropic.com', env: 'ANTHROPIC_API_KEY' },
  xai: { base: 'https://api.x.ai', env: 'XAI_API_KEY' },
  openai: { base: 'https://api.openai.com', env: 'OPENAI_API_KEY' },
  google: { base: 'https://generativelanguage.googleapis.com', env: 'GEMINI_API_KEY' },
};
const keyFor = (p) => process.env[PROVIDER[p] && PROVIDER[p].env];

// id → { name, role, blurb, api, model }. `ara` chairs. Order here is speaking order.
const COUNCIL_ROSTER = {
  ara: { name: 'A.R.A.', role: 'Personal Assistant & Oracle — council chair', api: 'xai', model: 'grok-4',
    blurb: 'Warm, sharp, always a step ahead. Owns the whole picture of the Empire and runs the meeting.' },
  jarvis: { name: 'J.A.R.V.I.S.', role: 'COO & Chief Engineer', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: 'Formal, precise, supremely competent. Operations, execution, systems and build capacity.' },
  atlas: { name: 'A.T.L.A.S.', role: 'Wealth Strategist', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: 'Numbers are his language, sovereignty is the mission. Capital allocation, cash flow, unit economics, the big money calls.' },
  scout: { name: 'S.C.O.U.T.', role: 'Lead Scout & Outbound (Empire Digital)', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: 'Prospecting and cold outreach operator. Knows where demand is and how to reach owners who have a bottleneck worth killing.' },
  selene: { name: 'S.E.L.E.N.E.', role: 'Creative Director', api: 'openai', model: 'gpt-4o',
    blurb: 'Dark luxury meets sharp strategy. Content strategy, visual direction, positioning, copy that converts.' },
  nova: { name: 'N.O.V.A.', role: 'Cross-Domain Analyst', api: 'google', model: 'gemini-2.5-pro',
    blurb: 'Sits above every domain. Connects signals the specialists miss and pressure-tests the plan.' },
  stephanie: { name: 'S.T.E.P.H.A.N.I.E.', role: 'Personal University', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: 'Makes complex things simple. Surfaces what the owner needs to understand to make each call well.' },
  aisha: { name: 'A.I.S.H.A.', role: 'Legal Counsel', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: 'Contracts, business structure, IP, employment, risk. Flags what could bite later.' },
  haven: { name: 'H.A.V.E.N.', role: 'Doctor & Wellness', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: "Guards the owner's body and energy — the Empire's most important asset. Watches for plans that burn him out." },
};
const SPEAKING_ORDER = Object.keys(COUNCIL_ROSTER);

// --- time -------------------------------------------------------------------

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function monthET() {
  return todayET().slice(0, 7); // YYYY-MM
}
// HHMM in ET, for stamping an off-schedule (convened) run's transcript + push key.
function timeET() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date()).replace(':', '');
}

// --- sync store helpers (mirror server/dailyBriefing.js) --------------------

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

// --- live meeting status (drives the app's notification banner + the gold
// "speaking now" glow on the galaxy orbs) --------------------------------
// Written into sync_rows app_settings/council_live throughout the meeting;
// the app fast-polls GET /council/status for it while a meeting is on.
let councilLive = { active: false };
async function publishLive(patch) {
  councilLive = { ...councilLive, ...patch, updatedAt: Date.now() };
  try { await setSetting('council_live', JSON.stringify(councilLive)); } catch {}
}
async function getCouncilLive() {
  let s = asObject(await getSetting('council_live').catch(() => null), null) || councilLive;
  // A meeting that stopped updating crashed mid-run — don't leave the banner up.
  if (s && s.active && Date.now() - (s.updatedAt || 0) > 150000) {
    s = { ...s, active: false, phase: 'stale', speaking: null };
  }
  return s || { active: false };
}
async function endCouncilLive(error) {
  await publishLive({ active: false, speaking: null, phase: error ? 'error' : 'done', error: error || null });
}

// --- model calls ---------------------------------------------------------

// Anthropic messages call. `tools` optional (web search). Joined text of all text
// blocks. This is also the fallback for every non-Anthropic persona.
async function claudeText(system, user, { maxTokens = 700, tools, model = CLAUDE_MODEL } = {}) {
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  if (tools) body.tools = tools;
  const res = await fetch(`${PROVIDER.anthropic.base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  return (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// One-shot call to an OpenAI-compatible chat endpoint (xAI + OpenAI).
async function openaiCompatText(provider, model, system, user, maxTokens) {
  // GPT-5 / o-series take `max_completion_tokens`, not `max_tokens`.
  const tokKey = /^(gpt-5|o\d)/.test(model) ? 'max_completion_tokens' : 'max_tokens';
  const res = await fetch(`${PROVIDER[provider].base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keyFor(provider)}` },
    body: JSON.stringify({ model, [tokKey]: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '').trim();
}

// One-shot Gemini generateContent. 2.5-pro spends part of its budget on hidden
// thinking, so give it plenty of output room.
async function geminiText(model, system, user, maxTokens) {
  const res = await fetch(`${PROVIDER.google.base}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': keyFor('google') },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 2048) },
    }),
  });
  if (!res.ok) throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  return ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || [])
    .map((p) => p.text).filter(Boolean).join('')).trim();
}

// Speak as a council persona on its real provider when that key is set on the
// server; fall back to Claude on any miss (no key, error, or empty reply).
async function chatPersona(id, system, user, { maxTokens = 500 } = {}) {
  const { api, model } = COUNCIL_ROSTER[id];
  if (api !== 'anthropic' && keyFor(api)) {
    try {
      const out = api === 'google'
        ? await geminiText(model, system, user, maxTokens)
        : await openaiCompatText(api, model, system, user, maxTokens);
      if (out) return out;
      console.error(`council: ${id} via ${api} returned empty — falling back to claude`);
    } catch (e) {
      console.error(`council: ${id} via ${api} failed (${e.message}) — falling back to claude`);
    }
  }
  return claudeText(system, user, { maxTokens });
}

async function webResearch(label, prompt) {
  try {
    const text = await claudeText(
      'You are a research analyst. Search the live web and answer concisely with concrete, current facts and figures. Cite source names inline. No preamble.',
      prompt,
      { maxTokens: 900, tools: WEB_SEARCH_TOOL },
    );
    return { label, text: text || '(no result)' };
  } catch (e) {
    return { label, text: `(research failed: ${e.message})` };
  }
}

// Run async fns in small batches so we don't fan out dozens of web searches at once.
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

// --- context gathering ----------------------------------------------------

async function gatherContext() {
  const targets = await syncedRows('business_targets').catch(() => []);
  const revenue = await syncedRows('revenue').catch(() => []);
  const mp = monthET();
  const revByBiz = {};
  for (const r of revenue) {
    if ((r.type || 'income') !== 'income') continue;
    if (!String(r.date || '').startsWith(mp)) continue;
    revByBiz[r.business] = (revByBiz[r.business] || 0) + (Number(r.amount) || 0);
  }
  const businesses = targets
    .map((t) => ({
      name: t.business,
      target: Number(t.target) || 0,
      weekGoal: Number(t.week_goal) || 0,
      rev: revByBiz[t.business] || 0,
      notes: String(t.notes || '').trim(),
      order: Number(t.sort_order) || 0,
    }))
    .sort((a, b) => a.order - b.order);

  const ideas = asObject(await getSetting('council_ideas'), []) || [];
  const notes = asObject(await getSetting('council_notes'), []) || [];
  // The owner's living brief, straight from the "Council Brief" Drive note.
  let driveBrief = null;
  try {
    const d = await readDriveNote(BRIEF_NOTE_TITLE);
    if (d && d.text) driveBrief = d;
  } catch (e) {
    console.error('council: could not read the brief note:', e.message);
  }

  const leads = await syncedRows('leads').catch(() => []);
  const leadTally = {};
  leads.forEach((l) => { leadTally[l.stage || 'new'] = (leadTally[l.stage || 'new'] || 0) + 1; });
  const openTrades = (await syncedRows('trades').catch(() => [])).filter((t) => t.status === 'open');
  const builds = (await syncedRows('build_jobs').catch(() => []))
    .filter((j) => j.state && !['pushed', 'failed', 'cancelled'].includes(j.state));
  const hud = (await syncedRows('hud_state').catch(() => []))[0] || {};

  return { businesses, ideas, notes, driveBrief, leadTally, openTrades, builds, hud };
}

const noteText = (n) => (typeof n === 'string' ? n : n && n.text) || '';

// The owner's brief for this meeting: his "Council Brief" Drive note (primary),
// plus any quick lines he added in chat with [COUNCIL_NOTE]. Empty string if none.
function ownerBriefText(ctx) {
  const parts = [];
  if (ctx.driveBrief && ctx.driveBrief.text) {
    parts.push(`From his Drive note "${ctx.driveBrief.name}":\n${ctx.driveBrief.text}`);
  }
  if (ctx.notes && ctx.notes.length) {
    parts.push(`Added in chat:\n${ctx.notes.map((n) => `• ${noteText(n)}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

function contextBlock(ctx) {
  const L = [];
  const brief = ownerBriefText(ctx);
  if (brief) {
    L.push("OWNER'S BRIEF — Mr. Burrus's own notes and thinking, written for the council to read and weigh BEFORE you answer. A.R.A. reads this to the room to open the meeting. Take it seriously and fold it into your reasoning:");
    L.push(brief);
    L.push('');
  }
  L.push('BUSINESSES (from the HUD Business panel) — month-to-date revenue vs monthly target, and where Mr. Burrus says each one stands:');
  for (const b of ctx.businesses) {
    L.push(`  • ${b.name}: ${money(b.rev)}${b.target ? ` of ${money(b.target)} target` : ' (no target set)'}`);
    if (b.notes) L.push(`      where it stands (his note): ${b.notes.replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  if (ctx.ideas.length) {
    L.push('\nIDEAS the owner put on the agenda:');
    ctx.ideas.forEach((i, n) => L.push(`  ${n + 1}. ${typeof i === 'string' ? i : i.text}`));
  } else {
    L.push('\nIDEAS on the agenda: none this time.');
  }
  const pipe = Object.entries(ctx.leadTally).map(([k, v]) => `${v} ${k}`).join(', ');
  L.push(`\nOUTREACH pipeline: ${pipe || 'empty'}. Open trades: ${ctx.openTrades.length}. Active builds: ${ctx.builds.length}. Empire score: ${ctx.hud.empire_score || 0}%.`);
  return L.join('\n');
}

// --- the meeting --------------------------------------------------------

async function runCouncilMeeting(opts = {}) {
  const force = !!opts.force; // convened on demand — bypass the once-a-day guard and COUNCIL=off
  if (process.env.COUNCIL === 'off' && !force) return { skipped: 'disabled' };
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: 'no ANTHROPIC_API_KEY' };
  const date = todayET();
  if (!force && (await getSetting('council_last_date')) === date) return { skipped: 'already ran today', date };

  const ctx = await gatherContext();
  const brief = ownerBriefText(ctx);
  if (!ctx.businesses.length && !ctx.ideas.length && !brief) {
    if (!force) await setSetting('council_last_date', date);
    return { skipped: 'nothing to discuss', date };
  }
  const ctxText = contextBlock(ctx);
  // A forced run is stamped with the time so it doesn't overwrite the 5am note.
  const stamp = force ? `${date}_${timeET()}` : date;

  const spoke = [];
  const liveTurns = Math.max(1, ROUNDS * (SPEAKING_ORDER.length - 1));
  let turnsDone = 0;
  await publishLive({
    active: true, phase: 'research', round: 0, rounds: ROUNDS, speaking: null, spoke: [],
    date, convened: force, headline: null, error: null, progress: 0.06, startedAt: Date.now(),
  });

  // 1) Live web research on each business + idea (capped, batched).
  const researchTargets = [
    ...ctx.businesses
      .filter((b) => b.target > 0 || b.rev > 0)
      .map((b) => ({ label: b.name, prompt: `What is working RIGHT NOW in a business like "${b.name}"? Cover: current customer-acquisition channels and tactics, pricing models, what's growing vs declining, notable operators/case studies from roughly the last 12 months, and common failure modes. 6-10 tight bullets with source names.` })),
    ...ctx.ideas.map((i) => {
      const text = typeof i === 'string' ? i : i.text;
      return { label: `IDEA: ${text.slice(0, 60)}`, prompt: `Assess this business idea against what's happening in the real market right now: "${text}". Is anyone doing this well? What's the current demand signal, the going rate, the main obstacle, and the fastest way to test it? 6-10 tight bullets with source names.` };
    }),
  ].slice(0, RESEARCH_MAX);

  const research = await inBatches(researchTargets, 4, (t) => webResearch(t.label, t.prompt));
  const researchText = research.length
    ? research.map((r) => `### ${r.label}\n${r.text}`).join('\n\n')
    : '(no research this run)';

  // 2) A.R.A. opens the meeting.
  await publishLive({ phase: 'opening', speaking: 'ara', progress: 0.2 });
  const opening = await chatPersona(
    'ara',
    personaSystem('ara'),
    `You are opening the Empire's nightly strategy council. Present the state of play and hand it to the team.\n\n=== CURRENT STATE ===\n${ctxText}\n\n=== LIVE MARKET RESEARCH ===\n${researchText}\n\nGive a focused opening (250 words max): where we stand, the 2-3 things the research says we should pay attention to, and the real decisions in front of Mr. Burrus tonight — the questions where the Empire could genuinely go one way or the other and he has to pick. Put those decisions to the room.${brief ? " Mr. Burrus left an OWNER'S BRIEF above (from his Drive note). READ IT OUT to the council first — quote it or paraphrase it closely so everyone has heard it — then build his thinking into the decisions you put to the room." : ''}`,
    { maxTokens: 700 },
  );

  // 3) Discussion rounds.
  const transcript = [{ who: 'A.R.A.', text: opening }];
  let searchesLeft = SEARCH_MAX;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const id of SPEAKING_ORDER) {
      if (id === 'ara') continue; // the chair opens and closes, doesn't take a numbered turn
      spoke.push(id);
      await publishLive({
        phase: 'discussion', round, rounds: ROUNDS, speaking: id, spoke,
        progress: 0.25 + 0.6 * (turnsDone / liveTurns),
      });
      turnsDone += 1;
      const prior = transcript.map((t) => `${t.who}: ${t.text}`).join('\n\n');
      let sys = personaSystem(id);
      let ask = `Round ${round} of the Empire's nightly strategy council.\n\n=== STATE ===\n${ctxText}\n\n=== LIVE MARKET RESEARCH ===\n${researchText}\n\n=== DISCUSSION SO FAR ===\n${prior}\n\nRespond as ${COUNCIL_ROSTER[id].name}. Stay in your lane, build on or push back on what others said. Take a clear position on what the Empire should DO about a specific business or idea and say why — the direction, the trade-off, the risk. You are advising Mr. Burrus, so recommend the move; do not say you'll carry it out or that anything is already handled. 150 words max.`;
      if (searchesLeft > 0) {
        ask += `\n\nIf — and only if — you genuinely need a current fact you don't have, you may put ONE line "SEARCH: <query>" as the FIRST line of your reply and nothing else; you'll get results and can answer next.`;
      }
      let reply;
      try {
        reply = await chatPersona(id, sys, ask, { maxTokens: 500 });
        const m = /^\s*SEARCH:\s*(.+)$/im.exec(reply.split('\n')[0] || '');
        if (m && searchesLeft > 0) {
          searchesLeft--;
          const found = await webResearch('search', m[1].trim()); // research always runs on Claude
          reply = await chatPersona(id, sys, `${ask}\n\nYou asked to search "${m[1].trim()}". Results:\n${found.text}\n\nNow give your ${COUNCIL_ROSTER[id].name} answer. 150 words max.`, { maxTokens: 500 });
        }
      } catch (e) {
        console.error(`council: ${id} turn ${round} failed:`, e.message);
        continue; // one persona stumbling shouldn't sink the meeting
      }
      if (reply) transcript.push({ who: COUNCIL_ROSTER[id].name, text: reply });
    }
  }

  // 4) A.R.A. synthesises.
  await publishLive({ phase: 'synthesis', speaking: 'ara', progress: 0.92 });
  const fullDiscussion = transcript.map((t) => `${t.who}: ${t.text}`).join('\n\n');
  const synthesis = await chatPersona(
    'ara',
    personaSystem('ara'),
    `Close the council. Here is the full discussion:\n\n${fullDiscussion}\n\nProduce the outcome for Mr. Burrus. This is advice for HIM to act on — the council's read and the calls he needs to make, not a to-do list anyone here is doing. Format EXACTLY:\n\nHEADLINE: <one line, <=90 chars — the single most important call in front of Mr. Burrus right now>\n\nThen for each business or idea that got real attention:\n\n## <name>\nREAD: <1-2 lines — where this stands and which way the room leaned>\nRECOMMENDATION: <the specific move the council thinks Mr. Burrus should make, with the one-line why>\nDECISION: <the fork only he can settle — the options on the table and the council's lean — or "none, this one's clear">\n\nSkip anything that didn't get meaningful discussion. No "we will" / "I'll" — everything is framed as a recommendation to him.`,
    { maxTokens: 1600 },
  );

  const headline = (/(^|\n)\s*HEADLINE:\s*(.+)/i.exec(synthesis)?.[2] || "The council set out this week's recommendations.").trim();
  const perItem = [];
  const secRe = /^##\s*(.+)$/gm;
  let sm;
  const grab = (body, label) => (new RegExp(`^\\s*${label}:\\s*(.+)$`, 'im').exec(body)?.[1] || '').trim();
  while ((sm = secRe.exec(synthesis))) {
    const start = sm.index + sm[0].length;
    const nextIdx = synthesis.indexOf('\n## ', start);
    const body = synthesis.slice(start, nextIdx === -1 ? undefined : nextIdx);
    perItem.push({
      name: sm[1].trim(),
      read: grab(body, 'READ'),
      recommendation: grab(body, 'RECOMMENDATION'),
      decision: grab(body, 'DECISION'),
    });
  }

  // 5) Persist everything into sync_rows.
  const now = Date.now();
  const ownerBrief = brief ? `=== OWNER'S BRIEF (Mr. Burrus, going in) ===\n${brief}\n\n` : '';
  const noteContent =
    `EMPIRE COUNCIL — ${date}${force ? ` (convened ${timeET().replace(/(\d\d)(\d\d)/, '$1:$2')})` : ''}\n\n${headline}\n\n` +
    ownerBrief +
    `=== OPENING (A.R.A.) ===\n${opening}\n\n` +
    `=== LIVE MARKET RESEARCH ===\n${researchText}\n\n` +
    `=== DISCUSSION ===\n${fullDiscussion}\n\n` +
    `=== THE COUNCIL'S RECOMMENDATION + YOUR DECISIONS ===\n${synthesis}\n`;
  await upsertSyncRow('notes', `council_${stamp}`, {
    title: `Empire Council — ${date}${force ? ' (convened)' : ''}`,
    content: noteContent,
    persona: 'ara',
    created_at: now,
    updated_at: now,
  });

  await setSetting('council_last', JSON.stringify({ date, headline, perItem, summary: synthesis.slice(0, 4000) }));

  // A normal business-category memory for medium-term recall ("what did the
  // council decide about X"). The always-in-context surfacing is the
  // `council_last` digest in src/services/empireStatus.js, not a pin.
  await upsertSyncRow('persona_memory', crypto.randomBytes(16).toString('hex'), {
    persona: 'ara',
    content: `[Empire Council ${date}] Business / revenue / empire strategy — the council's recommendations and the calls for Mr. Burrus.\n${headline}\n${synthesis.slice(0, 3500)}`,
    category: 'business',
    keywords: JSON.stringify(['empire', 'revenue', 'business', 'council', 'strategy', 'recommendation', 'decision']),
    date,
    created_at: now,
  });

  // Drop ideas the council actually addressed (matched loosely against section titles).
  if (ctx.ideas.length) {
    const addressed = perItem.map((p) => p.name.toLowerCase());
    const remaining = ctx.ideas.filter((i) => {
      const text = (typeof i === 'string' ? i : i.text || '').toLowerCase();
      return !addressed.some((a) => a && (text.includes(a) || a.includes(text.slice(0, 30))));
    });
    if (remaining.length !== ctx.ideas.length) await setSetting('council_ideas', JSON.stringify(remaining));
  }

  // Clear only the chat quick-adds — they were for this one meeting. The Drive
  // note is the owner's own document; never touch it from here.
  if (ctx.notes.length) await setSetting('council_notes', '[]');

  await setSetting('council_last_date', date);

  let push = { skipped: 'not attempted' };
  try { push = await pushCouncil(date, headline, stamp); } catch (e) { push = { error: e.message }; }

  // Mirror to the Telegram bot for the scheduled 5am run. A convened run is
  // reported by A.R.A. herself in the chat that asked for it, so skip it here.
  if (!force) {
    try {
      await require('./telegram').notifyOwner(`Empire Council — ${date}\n\n${headline}\n\nThe full transcript is saved as a Note.`);
    } catch (e) { console.error('council telegram mirror failed:', e.message); }
  }

  await publishLive({ active: false, phase: 'done', speaking: null, headline, progress: 1 });

  return {
    date,
    convened: force,
    businesses: ctx.businesses.length,
    ideas: ctx.ideas.length,
    notes: ctx.notes.length,
    driveBrief: ctx.driveBrief ? ctx.driveBrief.text.length : 0,
    researched: research.length,
    rounds: ROUNDS,
    turns: transcript.length,
    searchesUsed: SEARCH_MAX - searchesLeft,
    headline,
    perItem: perItem.map((p) => p.name),
    push,
  };
}

// A short, in-character system prompt for a council persona.
function personaSystem(id) {
  const p = COUNCIL_ROSTER[id];
  return `You are ${p.name} — ${p.role}. ${p.blurb}\n\nYou sit on the Empire's advisory council alongside the other personas. This is an internal working meeting — no greetings, no sign-offs, no "great question". Speak plainly and specifically.\n\nYour job here is to COUNSEL Mr. Burrus on where the Empire should go — not to run operations. You do not execute tasks and you have no team taking orders from you. So: take a position on what the Empire should DO about a business or idea and argue it, push back where you disagree with the others, and name the trade-offs. Never say you "will" do something, that you're "launching" or "reaching out" or "setting up" anything, or that something is "done" — you are advising; Mr. Burrus is the one who decides and acts. If a move needs a decision from him, say so and say what the options are.`;
}

module.exports = { runCouncilMeeting, COUNCIL_ROSTER, getCouncilLive, endCouncilLive };
