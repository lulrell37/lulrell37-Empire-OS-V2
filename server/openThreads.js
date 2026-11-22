// Open threads: topics Mr. Burrus started moving on with any persona and then
// dropped because something else came up (owner's request, 2026-11-20 — "I'm
// clearly interested in that, I just didn't continue"). Every 3 hours one Claude
// call reads the last day of conversation — every persona's Telegram history and
// the persona_memory rows the app and relays write — plus the current note, and
// rewrites the Drive note "Open Threads": what was started, how far it got, the
// next step. A thread leaves the list once the conversation finishes it or he
// says to drop it. Quiet when nothing changed. OPEN_THREADS=off stops it.
// [OPEN_THREADS] (every persona) reads it; node server/scripts/test-open-threads.js.
const { query } = require('./db');
const { syncedRows, getSetting, setSetting } = require('./syncStore');
const { claudeText } = require('./llm');

const NOTE = 'Open Threads';
const WINDOW_MS = 26 * 3600e3;
const MAX_CHARS = 60000;

function enabled() { return String(process.env.OPEN_THREADS || '').toLowerCase() !== 'off'; }

const et = (ms) => new Date(Number(ms)).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Conversation lines since `since`, oldest first: "[Nov 20, 5:13 PM] jarvis / him: …".
async function recentLines(since) {
  const out = [];
  const { rows } = await query('SELECT persona, role, content, ts FROM tg_messages WHERE ts > $1 ORDER BY ts ASC', [since]).catch(() => ({ rows: [] }));
  for (const r of rows) {
    const who = r.role === 'user' ? 'him' : r.persona;
    out.push({ ts: Number(r.ts), line: `[${et(r.ts)}] ${r.persona} chat · ${who}: ${String(r.content || '').replace(/\s+/g, ' ').slice(0, 700)}` });
  }
  const mem = await syncedRows('persona_memory').catch(() => []);
  for (const m of mem) {
    const ts = Number(m.created_at) || 0;
    if (ts > since) out.push({ ts, line: `[${et(ts)}] ${m.persona} (app/memory): ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 700)}` });
  }
  out.sort((a, b) => a.ts - b.ts);
  let text = out.map((o) => o.line).join('\n');
  if (text.length > MAX_CHARS) text = text.slice(-MAX_CHARS);
  return { text, count: out.length, newest: out.length ? out[out.length - 1].ts : 0 };
}

const SYSTEM = `You keep Mr. Burrus's "Open Threads" list. He talks to a team of AI personas and jumps between topics; when he starts moving on something (asks about it, makes a decision, plans it, has something built or drafted) and then the conversation moves on before it's finished, that topic is an open thread he clearly cares about. Your job is to keep the list accurate.

You get the current list and the last day of conversation. Return the full updated list in this exact format and nothing else:
- **Topic** — what was started and how far it got (one or two lines, concrete: decisions made, what's drafted or built, where it lives) · Next step: the single next action · Last touched: <date>
Rules:
- Add a thread only when he actually advanced it (a decision, a plan, a request, work started) and the conversation then moved to something else without finishing it. Passing mentions, jokes and questions that were fully answered are not threads.
- A thread that was finished, or that he said to drop or leave as is, comes off the list.
- A thread that came back up gets its progress and date updated.
- Merge duplicates. Most recent first. Keep his words for names and decisions; never invent progress.
- If nothing should be listed, reply exactly: NONE`;

function normalize(raw) {
  const t = String(raw || '').trim();
  if (!t || /^NONE\.?$/i.test(t)) return '';
  return t.split('\n').filter((l) => /^\s*-\s+\S/.test(l)).join('\n').trim();
}

async function readCurrent() {
  const g = require('./google');
  const n = await g.readDriveNote(NOTE).catch(() => null);
  return n && n.text ? n.text.replace(/^#.*\n+/, '').replace(/^_Updated.*\n+/m, '').trim() : '';
}

async function tick({ force = false } = {}) {
  if (!enabled()) return { skipped: 'off' };
  const g = require('./google');
  if (!(await g.googleLinked().catch(() => false))) return { skipped: 'google not linked' };
  const last = Number(await getSetting('open_threads_last', '0')) || 0;
  const convo = await recentLines(Date.now() - WINDOW_MS);
  if (!convo.count) return { skipped: 'no conversation' };
  if (!force && convo.newest <= last) return { skipped: 'nothing new' };
  const current = await readCurrent();
  const raw = await claudeText(SYSTEM, `CURRENT LIST:\n${current || '(empty)'}\n\nLAST DAY OF CONVERSATION (oldest first):\n${convo.text}`, { maxTokens: 1800 });
  const list = normalize(raw);
  await setSetting('open_threads_last', String(convo.newest));
  if (list === current) return { unchanged: true };
  const body = `# ${NOTE}\n_Updated ${et(Date.now())} ET — topics you started moving on and then set aside. Pick any one back up by name._\n\n${list || 'Nothing open right now.'}\n`;
  await g.saveDriveNote(NOTE, body);
  return { saved: true, threads: list ? list.split('\n').length : 0 };
}

async function readTag() {
  const t = await readCurrent().catch(() => '');
  return t || 'No open threads right now.';
}

const OPEN_THREADS_TOOLS = ' - [OPEN_THREADS] — his list of topics he started moving on and then set aside (kept up to date every few hours across every persona). Read it when he asks what\'s unfinished, what he was working on, or to pick something back up.';

module.exports = { tick, readTag, normalize, recentLines, OPEN_THREADS_TOOLS, NOTE, enabled };
