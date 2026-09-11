// Server-side S.C.O.U.T. — buying-intent signal discovery on a cron.
//
// Every SCOUT_INTERVAL_MIN minutes (default 30) it walks one metro x segment
// cell of the nationwide grid, pulls free intent signals for it (job postings,
// review velocity — see scoutSignals.js), qualifies the candidates against
// Empire Digital's ICP with one Claude call, scores each by heat, and writes the
// keepers into the `leads` table in the sync store. The app picks them up on its
// next pull and works them through the existing outreach pipeline
// (src/services/autoScout.js), highest heat first.
//
// OFF by default — set SCOUT_CRON=on. Discovery only; outreach stays app-side.
const crypto = require('crypto');
const { syncedRows, upsertSyncRow, getSetting, setSetting } = require('./syncStore');
const { chatAs, CLAUDE_MODEL } = require('./llm');
const { pickTarget } = require('./scoutTargets');
const { gatherSignals, heatFor } = require('./scoutSignals');
const telegram = require('./telegram');

const newId = () => crypto.randomBytes(16).toString('hex');
const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

const ICP_SYSTEM = `You are S.C.O.U.T., lead scout for Empire Digital — custom AI tools and automations built for one small business at a time. You are triaging intent signals (a business hiring for an ops role, a business with reviews about missed calls / booking problems). Keep only the ones that genuinely fit the ICP.

ICP: owner-operated US businesses, roughly 2-50 people, with a clear repetitive bottleneck that automation could kill (phones, scheduling, intake, quoting, follow-up, back-office). An owner who can say yes alone. NOT franchises, national chains, enterprises, marketplaces, directories, staffing/recruiting firms, or anything already clearly software-forward.

For each candidate you keep, output ONE line, pipe-delimited, nothing else:
KEEP | index | one-line reason this is a real opportunity and the bottleneck you'd pitch

Skip the rest silently. If none fit, output "NONE".`;

async function qualify(candidates) {
  if (!candidates.length) return [];
  const list = candidates.map((c, i) =>
    `[${i}] ${c.name} — ${c.segment}\n    signal: ${c.signal}${c._raw && c._raw.desc ? `\n    context: ${c._raw.desc}` : ''}${c._raw && c._raw.quotes ? `\n    quotes: ${c._raw.quotes.join(' / ')}` : ''}`,
  ).join('\n\n');
  let resp = '';
  try {
    resp = await chatAs('anthropic', CLAUDE_MODEL, ICP_SYSTEM, `CANDIDATES:\n\n${list}`, { maxTokens: 900 });
  } catch (e) {
    console.error('scout qualify failed:', e.message);
    return [];
  }
  const kept = [];
  for (const line of String(resp).split('\n')) {
    const m = line.match(/^\s*KEEP\s*\|\s*(\d+)\s*\|\s*(.+)$/i);
    if (!m) continue;
    const c = candidates[Number(m[1])];
    if (c) kept.push({ ...c, bottleneck: m[2].trim().slice(0, 300) });
  }
  return kept;
}

// Build the dedupe key set from existing leads.
function leadKey(name, website) {
  return `${String(name || '').toLowerCase().trim()}|${String(website || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}`;
}

async function runScoutSignalCycle() {
  if (process.env.SCOUT_CRON !== 'on') return { skipped: 'SCOUT_CRON not on' };

  const dailyCap = parseInt(await getSetting('scout_signal_daily_cap', '15'), 10) || 15;
  let stats = { date: todayET(), added: 0 };
  try {
    const raw = await getSetting('scout_signal_stats', '');
    if (raw) { const p = JSON.parse(raw); if (p && p.date === stats.date) stats = { date: p.date, added: p.added | 0 }; }
  } catch { /* fresh stats */ }
  if (stats.added >= dailyCap) return { done: 'daily cap reached', added: stats.added };

  const cursor = parseInt(await getSetting('scout_signal_cursor', '0'), 10) || 0;
  await setSetting('scout_signal_cursor', String(cursor + 1));
  const cell = pickTarget(cursor);

  const candidates = await gatherSignals(cell);
  if (!candidates.length) return { cell: `${cell.metro} / ${cell.segment}`, candidates: 0 };

  const existing = new Set((await syncedRows('leads').catch(() => [])).map((l) => leadKey(l.name, l.website)));
  const fresh = candidates.filter((c) => !existing.has(leadKey(c.name, c.website)));
  if (!fresh.length) return { cell: `${cell.metro} / ${cell.segment}`, candidates: candidates.length, fresh: 0 };

  const kept = await qualify(fresh);
  const room = Math.max(0, dailyCap - stats.added);
  const toAdd = kept.slice(0, room);

  const added = [];
  for (const c of toAdd) {
    const now = Date.now();
    const heat = heatFor({ signalType: c.signalType, signalAt: c.signalAt, count: 1 });
    await upsertSyncRow('leads', newId(), {
      name: c.name,
      business: c.business || c.name,
      website: c.website || '',
      contact: c.contact || '',
      bottleneck: c.bottleneck || '',
      segment: c.segment || `${cell.segment} · ${cell.metro}`,
      stage: 'new',
      source: `scout-signal:${c.signalType}`,
      signal: c.signal,
      heat,
      log: `Intent signal (${c.signalType}) — ${c.signal}`,
      created_at: now,
      updated_at: now,
    });
    added.push({ name: c.name, heat, signal: c.signal });
  }

  stats.added += added.length;
  await setSetting('scout_signal_stats', JSON.stringify(stats));

  if (added.length) {
    const top = added.sort((a, b) => b.heat - a.heat).slice(0, 5)
      .map((a) => `• ${a.name} (${a.heat}) — ${a.signal}`).join('\n');
    telegram.notifyOwner(`S.C.O.U.T. — ${added.length} warm lead${added.length === 1 ? '' : 's'} from ${cell.metro} / ${cell.segment} (${stats.added}/${dailyCap} today):\n${top}`).catch(() => {});
  }

  return { cell: `${cell.metro} / ${cell.segment}`, candidates: candidates.length, fresh: fresh.length, kept: kept.length, added: added.length };
}

module.exports = { runScoutSignalCycle };
