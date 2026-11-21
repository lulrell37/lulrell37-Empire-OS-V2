// Thinking ahead during the day (owner's smart-AI ask, 2026-11-20): at 11 AM,
// 3 PM and 7 PM ET A.R.A. checks what's coming up and what's slipping — the next
// few hours of his calendar, open tasks due today or overdue, and open threads
// that have sat for 2+ days — and sends him ONE short nudge only when something
// is worth his attention. One Claude call decides; "NOTHING" stays quiet. Items
// already nudged today aren't repeated (app_settings.day_nudge_seen).
// DAY_NUDGE=off stops it. node server/scripts/test-day-nudge.js.
const { syncedRows, getSetting, setSetting, todayET } = require('./syncStore');
const { claudeText } = require('./llm');

function enabled() { return String(process.env.DAY_NUDGE || '').toLowerCase() !== 'off'; }

function dueTasks(tasks, today) {
  return (tasks || []).filter((t) => t && !t.done && !t.completed && !t.deleted && t.due_date && String(t.due_date).slice(0, 10) <= today)
    .map((t) => `${t.title || t.name}${String(t.due_date).slice(0, 10) < today ? ` (overdue since ${String(t.due_date).slice(0, 10)})` : ' (due today)'}`);
}

const SYSTEM = `You are A.R.A., Mr. Burrus's assistant, deciding whether to nudge him right now. You get what's coming up and what's slipping. Send a nudge only for things that genuinely need his attention soon: an event in the next few hours, a task due today or overdue, or an open thread he started that has stalled 2+ days and has a clear next step. Skip anything listed under ALREADY NUDGED TODAY. If nothing qualifies, reply exactly NOTHING.
Otherwise reply with the nudge: 1-4 short lines, most urgent first, each with the one next action. Warm and brief, no greeting, no sign-off, no lists of everything. Then a final line "KEYS:" followed by a short comma-separated key for each item you mentioned.`;

function parse(raw) {
  const t = String(raw || '').trim();
  if (!t || /^NOTHING\.?$/i.test(t)) return null;
  const m = t.match(/\n?KEYS:\s*(.*)$/i);
  const keys = m ? m[1].split(',').map((k) => k.trim().toLowerCase()).filter(Boolean) : [];
  const text = (m ? t.slice(0, m.index) : t).trim();
  return text ? { text, keys } : null;
}

async function tick() {
  if (!enabled()) return { skipped: 'off' };
  const today = todayET();
  const g = require('./google');
  const linked = await g.googleLinked().catch(() => false);
  const cal = linked ? await g.calendarList({ days: 1 }).catch(() => '') : '';
  const tasks = dueTasks(await syncedRows('tasks').catch(() => []), today);
  const threads = linked ? await require('./openThreads').readTag().catch(() => '') : '';
  let seen = {}; try { seen = JSON.parse(await getSetting('day_nudge_seen', '{}')) || {}; } catch {}
  const seenToday = seen.day === today ? seen.keys || [] : [];
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', hour: 'numeric', minute: '2-digit' });
  const prompt = `NOW: ${now} ET\n\nCALENDAR (next 24h):\n${cal || '(not available)'}\n\nTASKS DUE TODAY OR OVERDUE:\n${tasks.join('\n') || '(none)'}\n\nOPEN THREADS:\n${threads || '(none)'}\n\nALREADY NUDGED TODAY: ${seenToday.join(', ') || '(nothing)'}`;
  const out = parse(await claudeText(SYSTEM, prompt, { maxTokens: 400 }));
  if (!out) return { quiet: true };
  await require('./talonAlerts').araNote(`🔔 ${out.text}`, undefined, { remember: true });
  await setSetting('day_nudge_seen', JSON.stringify({ day: today, keys: [...new Set([...seenToday, ...out.keys])] }));
  return { sent: true };
}

module.exports = { tick, parse, dueTasks, enabled };
