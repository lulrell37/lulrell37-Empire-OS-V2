// Daily HUD content, server side — Word + Fact of the Day (S.T.E.P.H.A.N.I.E.)
// and Verse of the Day (Abraham). Runs on a cron so the HUD is fresh before the
// app is even opened, and days where the app never opens still get covered.
//
// Writes straight into the sync store (sync_rows): the hud_state singleton for
// the live values, and app_settings rows for the per-item date stamp + rolling
// no-repeat history — the exact same storage the client uses, so whichever side
// runs first that day wins and the other no-ops.
//
// Disabled unless ANTHROPIC_API_KEY is set. Set DAILY_BRIEFING=off to force off.
const { query } = require('./db');

const TZ = 'America/New_York';
const HISTORY_MAX = 400;

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function syncedRow(table, syncId) {
  const { rows } = await query(
    'SELECT data FROM sync_rows WHERE table_name = $1 AND sync_id = $2 AND deleted = false',
    [table, syncId],
  );
  return rows[0] ? rows[0].data || {} : null;
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
async function history(kind) {
  try { const h = JSON.parse((await getSetting(`daily_${kind}_history`)) || '[]'); return Array.isArray(h) ? h : []; }
  catch { return []; }
}
async function remember(kind, value) {
  const v = String(value || '').trim();
  if (!v) return;
  const h = await history(kind);
  const next = [v, ...h.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, HISTORY_MAX);
  await setSetting(`daily_${kind}_history`, JSON.stringify(next));
}

async function claude(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const d = await res.json();
  const raw = (d.content && d.content[0] && d.content[0].text || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in reply');
  return JSON.parse(m[0]);
}

const PROMPTS = {
  word: (seen) => [
    `You are S.T.E.P.H.A.N.I.E., Mr. Burrus's personal educator, choosing the HUD "Word of the Day". Pick ONE word that sharpens a sharp mind — precise, genuinely useful, a notch above everyday speech, not obscure trivia. Reply with ONLY a JSON object: {"word":"...","phonetic":"/.../","definition":"one clear sentence"}`,
    `Do NOT repeat any of these already-used words: ${seen || '(none yet)'}`,
  ],
  fact: (seen) => [
    `You are S.T.E.P.H.A.N.I.E., Mr. Burrus's personal educator, choosing the HUD "Fact of the Day". Pick ONE true, genuinely interesting fact — science, history, systems, money, the natural world — the kind that makes you stop and think. One or two sentences. Reply with ONLY a JSON object: {"fact":"..."}`,
    `Do NOT repeat any of these already-used facts: ${seen || '(none yet)'}`,
  ],
  verse: (seen) => [
    `You are Abraham, Mr. Burrus's pastor, choosing the HUD "Verse of the Day" from the Holy Bible. Pick ONE verse that speaks to a man building an empire on faith — strength, wisdom, diligence, purpose, covenant, perseverance. Quote it faithfully. Reply with ONLY a JSON object: {"text":"the verse text","ref":"Book Chapter:Verse"}`,
    `Do NOT repeat any of these already-used references: ${seen || '(none yet)'}`,
  ],
};

async function ensureKind(kind, today, hudPatch) {
  if ((await getSetting(`daily_${kind}_date`)) === today) return false;
  const seen = (await history(kind)).slice(0, 320).join(' | ');
  const [sys, user] = PROMPTS[kind](seen);
  const r = await claude(sys, user);
  if (kind === 'word' && r.word) {
    hudPatch.word_of_day = String(r.word).trim();
    hudPatch.word_phonetic = String(r.phonetic || '').trim();
    hudPatch.word_def = String(r.definition || '').trim();
    await remember('word', r.word);
  } else if (kind === 'fact' && r.fact) {
    hudPatch.fact_of_day = String(r.fact).trim();
    await remember('fact', r.fact);
  } else if (kind === 'verse' && r.text) {
    hudPatch.verse_of_day = String(r.text).trim();
    hudPatch.verse_ref = String(r.ref || '').trim();
    await remember('verse', r.ref || r.text);
  } else {
    return false;
  }
  await setSetting(`daily_${kind}_date`, today);
  return true;
}

async function runDailyBriefing() {
  if (process.env.DAILY_BRIEFING === 'off') return { skipped: 'disabled' };
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: 'no ANTHROPIC_API_KEY' };
  const today = todayET();
  const hud = (await syncedRow('hud_state', 'singleton')) || {};
  const patch = {};
  const done = [];
  for (const kind of ['word', 'fact', 'verse']) {
    try { if (await ensureKind(kind, today, patch)) done.push(kind); }
    catch (e) { console.error(`daily ${kind} failed:`, e.message); }
  }
  if (Object.keys(patch).length) {
    await upsertSyncRow('hud_state', 'singleton', { ...hud, ...patch });
  }
  return { today, generated: done };
}

module.exports = { runDailyBriefing };
