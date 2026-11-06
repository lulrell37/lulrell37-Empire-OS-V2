// S.C.R.I.B.E.'s Monday scripts. Mondays at 8 AM ET, an hour after S.E.L.E.N.E.'s
// Instagram watch, he writes 5 talking-head scripts in Mr. Burrus's voice and hands
// them to A.R.A. Each one is filed to Drive as "Script — <title>" (the same names
// the app's [SCRIPT_OPEN] reads), or the app's Notes if Drive is down. A.R.A. only
// tells him they came in, with links: she never reads them out, and a script goes
// in the message only if it couldn't be filed anywhere. Once a week.
// MONDAY_SCRIPTS=off stops it.
const { chatAs } = require('./llm');
const { ROSTER } = require('./personas');
const { getSetting, setSetting, saveMemory, todayET } = require('./syncStore');
const { saveNote } = require('./personaTools');
const { sendFromAra } = require('./talonAlerts');

const COUNT = 5;
const FRESH_BRIEF = 8 * 86400e3;

// "=== SCRIPT 1: Title ===" blocks -> [{ title, body }]. Pure.
function parseScripts(raw) {
  const out = [];
  const re = /^\s*={2,}\s*SCRIPT\s*\d+\s*[:—-]\s*(.+?)\s*={2,}\s*$/gim;
  const heads = [...String(raw || '').matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : raw.length;
    const body = raw.slice(h.index + h[0].length, end).trim();
    if (h[1] && body) out.push({ title: h[1].replace(/[*_#]/g, '').trim(), body });
  });
  return out;
}

async function recentTitles() {
  const raw = await getSetting('scribe_recent_titles', '[]').catch(() => '[]');
  try { const a = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function write(have, brief, recent) {
  const p = ROSTER.scribe;
  const need = COUNT - have.length;
  const sys = `You are S.C.R.I.B.E., the Empire's script writer. You report to S.E.L.E.N.E.

${p.voice}

Write talking-head scripts: Mr. Burrus alone, speaking to camera, 30-60 seconds (about 80-150 spoken words), ready to film. Hook in the first line. Spoken lines first; put any on-screen text or delivery notes in (parentheses), and keep them few. Each one lands on a single idea, on a different topic and a different opening move from the others. Use a trend from the brief only where it really fits him; his voice comes first. Never invent personal stories, facts or numbers about him: where a real story of his belongs, write (your story here: <what kind>).

Format exactly, nothing before or after:
=== SCRIPT 1: Short title ===
the script
=== SCRIPT 2: Short title ===
the script`;
  const user = `Write ${need} script${need > 1 ? 's' : ''} for this week, ${todayET()}.\n\nS.E.L.E.N.E.'S BRIEF:\n${brief || '(no brief this week: write from his themes)'}\n\nALREADY WRITTEN, don't repeat these topics: ${[...recent, ...have.map((s) => s.title)].join(' | ') || 'none'}`;
  return parseScripts(await chatAs(p.api, p.model, sys, [{ role: 'user', content: user }], { maxTokens: 1000 + need * 450 }));
}

async function runMondayScripts({ force = false } = {}) {
  const week = todayET();
  if (!force && (await getSetting('scribe_monday_date', '')) === week) return { skipped: 'already sent today' };
  let brief = '';
  try {
    const b = JSON.parse(await getSetting('selene_trend_brief', '{}') || '{}');
    if (Date.now() - Number(b.at || 0) < FRESH_BRIEF) brief = String(b.body || '');
  } catch { /* no brief: he writes from the voice alone */ }
  const recent = await recentTitles();

  // One more try if he comes back short: "5 scripts" has to mean 5.
  let scripts = [];
  for (let i = 0; i < 2 && scripts.length < COUNT; i++) {
    scripts = [...scripts, ...(await write(scripts, brief, recent))].slice(0, COUNT);
  }
  if (!scripts.length) throw new Error('no scripts came back');
  await setSetting('scribe_monday_date', week);

  const filed = await Promise.all(scripts.map((s) => saveNote(`Script — ${s.title}`, s.body, 'scribe').catch((e) => ({ lost: e.message }))));
  const short = scripts.length < COUNT ? ` He only got ${scripts.length} of ${COUNT} written.` : '';
  const lines = scripts.map((s, i) => {
    const r = filed[i];
    if (r.lost) return `**${i + 1}. ${s.title}** (couldn't be filed, so here it is)\n${s.body}`;
    const link = String(r.ok || '').match(/\[[^\]]+\]\([^)]+\)/);
    return `${i + 1}. ${link ? link[0] : `${s.title} (in the app's Notes)`}`;
  });
  const text = `🎬 **S.C.R.I.B.E. → A.R.A.: this week's talking heads came in**, Mr. Burrus.${short}\n\n${lines.join('\n')}`;
  const spoken = `S.C.R.I.B.E. → A.R.A.: this week's ${scripts.length} talking-head scripts came in, Mr. Burrus.${filed.every((r) => r.ok) ? " They're in your Drive." : ' The message says where each one landed.'}${short}`;
  const sent = await sendFromAra(text, spoken);
  await setSetting('scribe_recent_titles', JSON.stringify([...scripts.map((s) => s.title), ...recent].slice(0, 30))).catch(() => {});
  await saveMemory('scribe', `[Monday scripts ${week}] ${scripts.map((s) => s.title).join(' | ')}`).catch(() => {});
  await saveMemory('ara', `[S.C.R.I.B.E. handed you this week's talking-head scripts; you sent them to Mr. Burrus. They're in notes as "Script — <title>"] ${scripts.map((s) => s.title).join(' | ')}`).catch(() => {});
  return { sent, count: scripts.length, titles: scripts.map((s) => s.title) };
}

module.exports = { runMondayScripts, parseScripts };
