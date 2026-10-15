// Timed reminders — "remind me at 3 to call the bank". A.R.A. sets one with
// [REMIND_ME: what | YYYY-MM-DD HH:MM] (Eastern); the reminder cron checks every
// minute and, once one is due, pushes it to every registered device and drops
// it into A.R.A.'s Telegram chat. Each fires once (sent_at + push_log key).
const { query } = require('./db');
const { newId } = require('./syncStore');

const TZ = 'America/New_York';

// Offset (ms) of the owner's timezone from UTC at instant `ms`.
function tzOffset(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// "YYYY-MM-DD HH:MM" (or with a T, optional am/pm) in Eastern time -> epoch ms.
// Also takes a relative "+20m" / "+2h" / "+1d". null when it can't be read.
function parseWhen(s) {
  s = String(s || '').trim();
  const rel = /^\+?\s*(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0].toLowerCase();
    return Date.now() + n * (unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
  if (!m) return null;
  let h = m[4] != null ? Number(m[4]) : 9; // date only -> 9 AM
  const min = m[5] != null ? Number(m[5]) : 0;
  if (m[6]) { h %= 12; if (/pm/i.test(m[6])) h += 12; }
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], h, min);
  let utc = wall - tzOffset(wall);
  utc = wall - tzOffset(utc); // settle across a DST edge
  return utc;
}

function whenLabel(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(ms));
}

async function addReminder(text, when, persona = 'ara') {
  const due = parseWhen(when);
  if (!text || due == null) return { warn: `couldn't read the reminder time "${when}" — use YYYY-MM-DD HH:MM (Eastern)` };
  if (due < Date.now() - 60000) return { warn: `reminder time ${whenLabel(due)} is already in the past — not set` };
  await query(
    'INSERT INTO reminders (id, persona, text, due_at, created_at) VALUES ($1, $2, $3, $4, $5)',
    [newId(), persona, text, due, Date.now()],
  );
  const { rows } = await query('SELECT 1 FROM devices LIMIT 1');
  if (!rows.length) return { warn: `reminder set for ${whenLabel(due)}, but no phone is registered for push — it'll only come through on Telegram` };
  return { ok: `reminder set: "${text}" — ${whenLabel(due)} (push notification)` };
}

// Send every due, unsent reminder. Called by the cron every minute.
async function tick() {
  const { rows } = await query(
    'SELECT * FROM reminders WHERE sent_at IS NULL AND due_at <= $1 ORDER BY due_at LIMIT 20',
    [Date.now()],
  );
  for (const r of rows) {
    // Claim it first so an overlapping tick can't send twice.
    const claim = await query('UPDATE reminders SET sent_at = $2 WHERE id = $1 AND sent_at IS NULL', [r.id, Date.now()]);
    if (!claim.rowCount) continue;
    try {
      await require('./pushSender').pushAlert(`reminder:${r.id}`, 'A.R.A. — Reminder', r.text, { kind: 'reminder', persona: r.persona });
    } catch (e) { console.error('reminder push failed:', r.id, e.message); }
    try { await require('./telegram').notifyOwner(`⏰ Reminder, Mr. Burrus: ${r.text}`); } catch (e) { console.error('reminder telegram failed:', e.message); }
  }
  return { sent: rows.length };
}

async function upcoming(limit = 10) {
  const { rows } = await query('SELECT text, due_at FROM reminders WHERE sent_at IS NULL ORDER BY due_at LIMIT $1', [limit]);
  return rows;
}

module.exports = { addReminder, tick, upcoming, parseWhen, whenLabel };
