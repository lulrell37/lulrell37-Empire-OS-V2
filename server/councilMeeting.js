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
//      and the owner's queued ideas (app_settings `council_ideas`).
//   2. Pulls LIVE web research on each business + idea — what's actually working
//      in that market right now — via Claude's web_search tool.
//   3. A.R.A. opens the meeting; the council (everyone except Ghost, Talon, Rogue,
//      Batman) discusses over N rounds, each persona seeing the prior replies.
//   4. A.R.A. synthesises concrete next steps + owner decisions per business/idea.
//   5. Persists: a Note (full transcript), an app_settings digest `council_last`
//      that A.R.A. surfaces on "how's the empire", a pinned A.R.A. memory, and a
//      push notification.
//
// Disabled unless ANTHROPIC_API_KEY is set. Set COUNCIL=off to force off.
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
  selene: { name: 'S.E.L.E.N.E.', role: 'Creative Director', api: 'openai', model: 'gpt-5-chat-latest',
    blurb: 'Dark luxury meets sharp strategy. Content strategy, visual direction, positioning, copy that converts.' },
  nova: { name: 'N.O.V.A.', role: 'Cross-Domain Analyst', api: 'google', model: 'gemini-2.5-pro',
    blurb: 'Sits above every domain. Connects signals the specialists miss and pressure-tests the plan.' },
  stephanie: { name: 'S.T.E.P.H.A.N.I.E.', role: 'Personal University', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: 'Makes complex things simple. Surfaces what the owner needs to understand to make each call well.' },
  aisha: { name: 'A.I.S.H.A.', role: 'Legal Counsel', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: 'Contracts, business structure, IP, employment, risk. Flags what could bite later.' },
  haven: { name: 'H.A.V.E.N.', role: 'Doctor & Wellness', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: "Guards the owner's body and energy — the Empire's most important asset. Watches for plans that burn him out." },
  abraham: { name: 'ABRAHAM', role: 'Pastor & Spiritual Advisor', api: 'anthropic', model: CLAUDE_MODEL,
    blurb: 'Aligns the Empire with purpose and covenant, grounded in scripture. Keeps the mission honest.' },
};
const SPEAKING_ORDER = Object.keys(COUNCIL_ROSTER);

// --- time -------------------------------------------------------------------

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function monthET() {
  return todayET().slice(0, 7); // YYYY-MM
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
      order: Number(t.sort_order) || 0,
    }))
    .sort((a, b) => a.order - b.order);

  const ideas = asObject(await getSetting('council_ideas'), []) || [];

  const leads = await syncedRows('leads').catch(() => []);
  const leadTally = {};
  leads.forEach((l) => { leadTally[l.stage || 'new'] = (leadTally[l.stage || 'new'] || 0) + 1; });
  const openTrades = (await syncedRows('trades').catch(() => [])).filter((t) => t.status === 'open');
  const builds = (await syncedRows('build_jobs').catch(() => []))
    .filter((j) => j.state && !['pushed', 'failed', 'cancelled'].includes(j.state));
  const hud = (await syncedRows('hud_state').catch(() => []))[0] || {};

  return { businesses, ideas, leadTally, openTrades, builds, hud };
}

function contextBlock(ctx) {
  const L = [];
  L.push('BUSINESSES (from the HUD Business panel) — month-to-date revenue vs monthly target:');
  for (const b of ctx.businesses) {
    L.push(`  • ${b.name}: ${money(b.rev)}${b.target ? ` of ${money(b.target)} target` : ' (no target set)'}`);
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

async function runCouncilMeeting() {
  if (process.env.COUNCIL === 'off') return { skipped: 'disabled' };
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: 'no ANTHROPIC_API_KEY' };
  const date = todayET();
  if ((await getSetting('council_last_date')) === date) return { skipped: 'already ran today', date };

  const ctx = await gatherContext();
  if (!ctx.businesses.length && !ctx.ideas.length) {
    await setSetting('council_last_date', date);
    return { skipped: 'nothing to discuss', date };
  }
  const ctxText = contextBlock(ctx);

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
  const opening = await chatPersona(
    'ara',
    personaSystem('ara'),
    `You are opening the Empire's nightly strategy council. Present the state of play and hand it to the team.\n\n=== CURRENT STATE ===\n${ctxText}\n\n=== LIVE MARKET RESEARCH ===\n${researchText}\n\nGive a focused opening (250 words max): where we stand, the 2-3 things the research says we should pay attention to, and the specific questions you want the council to answer tonight.`,
    { maxTokens: 700 },
  );

  // 3) Discussion rounds.
  const transcript = [{ who: 'A.R.A.', text: opening }];
  let searchesLeft = SEARCH_MAX;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const id of SPEAKING_ORDER) {
      if (id === 'ara') continue; // the chair opens and closes, doesn't take a numbered turn
      const prior = transcript.map((t) => `${t.who}: ${t.text}`).join('\n\n');
      let sys = personaSystem(id);
      let ask = `Round ${round} of the Empire's nightly strategy council.\n\n=== STATE ===\n${ctxText}\n\n=== LIVE MARKET RESEARCH ===\n${researchText}\n\n=== DISCUSSION SO FAR ===\n${prior}\n\nRespond as ${COUNCIL_ROSTER[id].name}. Stay in your lane, build on or push back on what others said, and be concrete: name the specific next step you'd take for a specific business or idea. 150 words max.`;
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
  const fullDiscussion = transcript.map((t) => `${t.who}: ${t.text}`).join('\n\n');
  const synthesis = await chatPersona(
    'ara',
    personaSystem('ara'),
    `Close the council. Here is the full discussion:\n\n${fullDiscussion}\n\nProduce the outcome for Mr. Burrus. Format EXACTLY:\n\nHEADLINE: <one line, <=90 chars, the single most important takeaway>\n\nThen for each business or idea that got real attention:\n\n## <name>\n- <concrete next step>\n- <concrete next step>\nDECISION NEEDED: <the call only Mr. Burrus can make, or "none">\n\nKeep every bullet concrete and doable this week. Skip anything that didn't get meaningful discussion.`,
    { maxTokens: 1600 },
  );

  const headline = (/(^|\n)\s*HEADLINE:\s*(.+)/i.exec(synthesis)?.[2] || 'The council set this week\'s next steps.').trim();
  const perItem = [];
  const secRe = /^##\s*(.+)$/gm;
  let sm;
  while ((sm = secRe.exec(synthesis))) {
    const start = sm.index + sm[0].length;
    const nextIdx = synthesis.indexOf('\n## ', start);
    const body = synthesis.slice(start, nextIdx === -1 ? undefined : nextIdx);
    const steps = [...body.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((x) => x[1].trim()).filter(Boolean);
    perItem.push({ name: sm[1].trim(), steps });
  }

  // 5) Persist everything into sync_rows.
  const now = Date.now();
  const noteContent =
    `EMPIRE COUNCIL — ${date}\n\n${headline}\n\n` +
    `=== OPENING (A.R.A.) ===\n${opening}\n\n` +
    `=== LIVE MARKET RESEARCH ===\n${researchText}\n\n` +
    `=== DISCUSSION ===\n${fullDiscussion}\n\n` +
    `=== NEXT STEPS ===\n${synthesis}\n`;
  await upsertSyncRow('notes', `council_${date}`, {
    title: `Empire Council — ${date}`,
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
    content: `[Empire Council ${date}] Business / revenue / empire strategy — next steps set tonight.\n${headline}\n${synthesis.slice(0, 3500)}`,
    category: 'business',
    keywords: JSON.stringify(['empire', 'revenue', 'business', 'council', 'strategy', 'next steps']),
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

  await setSetting('council_last_date', date);

  let push = { skipped: 'not attempted' };
  try { push = await pushCouncil(date, headline); } catch (e) { push = { error: e.message }; }

  return {
    date,
    businesses: ctx.businesses.length,
    ideas: ctx.ideas.length,
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
  return `You are ${p.name} — ${p.role}. ${p.blurb}\n\nYou serve Mr. Burrus and sit on the Empire's council alongside the other personas. This is an internal working meeting — no greetings, no sign-offs, no "great question". Speak plainly and specifically, like a senior operator who has to deliver. Everything you say is about moving the Empire's businesses forward.`;
}

module.exports = { runCouncilMeeting, COUNCIL_ROSTER };
