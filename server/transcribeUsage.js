// Measured speech-to-text usage (owner's ask 2026-11-24). Every transcription call (Groq or OpenAI) is
// logged here with its provider, whether it was a fallback and why, the job that asked, audio seconds and
// file size. Stored in app_settings.transcribe_usage: { entries: [...last 90 days...], days: { 'YYYY-MM-DD': totals } };
// entries older than KEEP_DAYS roll into per-day totals (kept). [TRANSCRIBE_USAGE] reads it.
const KEEP_DAYS = 90;
const JOBS = ['clip scan', 'auto clip', 'clip captions', 'raw edit', 'transcribe', 'voice note', 'other'];
const PRICE = { groqPerHour: 0.04, openaiPerMinute: 0.006 };
const KEY = 'transcribe_usage';

let store = {
  get: (k, f) => require('./syncStore').getSetting(k, f),
  set: (k, v) => require('./syncStore').setSetting(k, v),
};
const setStore = (s) => { store = s; };

const normJob = (j) => { const x = String(j || '').toLowerCase().trim(); return JOBS.includes(x) ? x : 'other'; };
const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms)); // YYYY-MM-DD

const emptyDay = () => ({ n: 0, groqSec: 0, openaiSec: 0, fallbacks: 0, bytes: 0, jobs: {} });
function addTo(day, e) {
  day.n += 1;
  day[e.provider === 'groq' ? 'groqSec' : 'openaiSec'] += e.sec || 0;
  if (e.fallback) day.fallbacks += 1;
  day.bytes += e.bytes || 0;
  day.jobs[e.job] = (day.jobs[e.job] || 0) + (e.sec || 0);
  return day;
}

// Move entries older than KEEP_DAYS into per-day totals. Pure.
function roll(data, now = Date.now()) {
  const out = { entries: [], days: { ...(data.days || {}) } };
  const cutoff = now - KEEP_DAYS * 86400000;
  for (const e of data.entries || []) {
    if (e.t >= cutoff) { out.entries.push(e); continue; }
    const d = etDay(e.t);
    out.days[d] = addTo(out.days[d] ? { ...out.days[d], jobs: { ...out.days[d].jobs } } : emptyDay(), e);
  }
  return out;
}

async function load() {
  try {
    const d = JSON.parse((await store.get(KEY, '{}')) || '{}');
    return { entries: Array.isArray(d.entries) ? d.entries : [], days: d.days && typeof d.days === 'object' ? d.days : {} };
  } catch { return { entries: [], days: {} }; }
}

let chain = Promise.resolve();
// Never throws and never blocks a transcription: a failed write logs for the sentinel.
function record(e, now = Date.now()) {
  const entry = {
    t: now, provider: e.provider === 'groq' ? 'groq' : 'openai', fallback: !!e.fallback, why: e.why ? String(e.why).slice(0, 120) : '',
    job: normJob(e.job), sec: Math.round((Number(e.sec) || 0) * 10) / 10, bytes: Math.round(Number(e.bytes) || 0),
  };
  chain = chain.then(async () => {
    const data = roll(await load(), now);
    data.entries.push(entry);
    await store.set(KEY, JSON.stringify(data));
  }).catch((err) => console.error(`transcribe usage failed: ${err.message}`));
  return chain;
}

const cost = (groqSec, openaiSec) => (groqSec / 3600) * PRICE.groqPerHour + (openaiSec / 60) * PRICE.openaiPerMinute;

// Totals over the days where inRange(dayString) is true, from entries (exact) and rolled-up days.
function summarize(data, inRange) {
  const t = emptyDay();
  const fold = (d) => {
    t.n += d.n; t.groqSec += d.groqSec; t.openaiSec += d.openaiSec; t.fallbacks += d.fallbacks; t.bytes += d.bytes;
    for (const [j, s] of Object.entries(d.jobs || {})) t.jobs[j] = (t.jobs[j] || 0) + s;
  };
  const seen = {};
  for (const e of data.entries || []) { const d = etDay(e.t); if (inRange(d)) addTo(seen[d] = seen[d] || emptyDay(), e); }
  for (const d of Object.values(seen)) fold(d);
  for (const [day, d] of Object.entries(data.days || {})) if (inRange(day)) fold(d);
  t.cost = cost(t.groqSec, t.openaiSec);
  return t;
}

const hrs = (s) => (s / 3600).toFixed(2);
function block(label, t) {
  if (!t.n) return `${label}: no transcriptions logged.`;
  const jobs = Object.entries(t.jobs).sort((a, b) => b[1] - a[1]).map(([j, s]) => `${j} ${hrs(s)} h`).join(', ');
  return `${label}: ${hrs(t.groqSec + t.openaiSec)} audio hours in ${t.n} calls. By job: ${jobs}. Groq ${hrs(t.groqSec)} h, OpenAI ${hrs(t.openaiSec)} h; ${t.fallbacks} fell back to OpenAI. Estimated cost $${t.cost.toFixed(2)} (Groq $${PRICE.groqPerHour}/h, OpenAI $${PRICE.openaiPerMinute}/min).`;
}

function report(data, now = Date.now()) {
  const month = etDay(now).slice(0, 7);
  const today = etDay(now);
  const weekFrom = etDay(now - 6 * 86400000);
  const m = summarize(data, (d) => d.slice(0, 7) === month);
  const w = summarize(data, (d) => d >= weekFrom && d <= today);
  const why = {};
  for (const e of data.entries || []) if (e.fallback && etDay(e.t) >= weekFrom) why[e.why || 'unknown'] = (why[e.why || 'unknown'] || 0) + 1;
  const whyLine = Object.keys(why).length ? `\nFallback reasons, last 7 days: ${Object.entries(why).map(([k, v]) => `${k} x${v}`).join(', ')}.` : '';
  return `${block(`This month (${month})`, m)}\n${block('Last 7 days', w)}${whyLine}`;
}

async function usageTag() { return report(await load()); }

const USAGE_TOOLS = ` - [TRANSCRIBE_USAGE] — measured speech-to-text use, this month and the last 7 days: audio hours in total and per job (clip scan, auto clip, clip captions, raw edit, transcribe, voice note), Groq versus OpenAI hours, how many calls fell back from Groq and why, and the estimated cost in dollars. Use it when he asks what transcription is costing or using.`;

module.exports = { record, load, roll, summarize, report, usageTag, setStore, normJob, etDay, cost, USAGE_TOOLS, KEEP_DAYS, JOBS, PRICE };
