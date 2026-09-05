// Scheduled nudge sender (phase 4).
//
// Computes "act on this now" signals from the synced dataset — the same shape of
// nudges the app shows in-app (src/services/nudges.js) — and pushes them to every
// registered device through Expo's push service. Each nudge fires at most once
// per day: `push_log` holds a per-nudge key so a restart or an overlapping cron
// tick can't double-send.
//
// Single owner -> one dataset, so there is no per-user split: nudges are computed
// over the whole `sync_rows` table and sent to all rows of `devices`.
const { query } = require('./db');

const TZ = 'America/New_York'; // the owner's timezone (Waldorf, MD)
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// --- time --------------------------------------------------------------------

// Current date + hour in the owner's timezone, without pulling in a tz library.
function localNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

// (month, day) for an important_dates value: "YYYY-MM-DD", "MM-DD", or "--MM-DD".
function monthDay(s) {
  s = String(s || '');
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return [Number(m[2]), Number(m[3])];
  m = /^-{0,2}(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) return [Number(m[1]), Number(m[2])];
  return null;
}

// Whole days from the ET "today" to the next occurrence of (month, day). Both
// sides are computed in UTC so the arithmetic is pure calendar days.
function daysUntil([mm, dd], todayStr) {
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const today = Date.UTC(ty, tm - 1, td);
  let next = Date.UTC(ty, mm - 1, dd);
  if (next < today) next = Date.UTC(ty + 1, mm - 1, dd);
  return Math.round((next - today) / 86400000);
}

// --- data -------------------------------------------------------------------

// Live rows for one app table straight out of the sync store (tombstones out).
async function syncedRows(table) {
  const { rows } = await query(
    'SELECT sync_id, data FROM sync_rows WHERE table_name = $1 AND deleted = false',
    [table],
  );
  return rows.map((r) => ({ ...(r.data || {}), sync_id: r.sync_id }));
}

function asObject(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// --- nudge computation ------------------------------------------------------

// Returns [{ key, title, body, data }] that apply right now. `key` carries the
// date (or a state marker) so push_log de-dupes to one send per occurrence.
async function computeNudges() {
  const { date, hour } = localNow();
  const out = [];

  const tasks = (await syncedRows('tasks').catch(() => [])).filter((t) => !t.completed);
  const overdue = tasks.filter((t) => t.due_date && t.due_date < date);
  const dueToday = tasks.filter((t) => t.due_date === date);

  // Morning briefing — 7am–10am ET.
  if (hour >= 7 && hour < 10) {
    const bits = [];
    if (dueToday.length) bits.push(`${dueToday.length} task${dueToday.length > 1 ? 's' : ''} due today`);
    if (overdue.length) bits.push(`${overdue.length} overdue`);
    const soon = (await syncedRows('important_dates').catch(() => []))
      .map((d) => {
        const md = monthDay(d.date);
        return md ? { label: d.label, daysOut: daysUntil(md, date) } : null;
      })
      .filter((d) => d && d.daysOut <= 3)
      .sort((a, b) => a.daysOut - b.daysOut);
    for (const d of soon) {
      bits.push(`${d.label} ${d.daysOut === 0 ? 'today' : d.daysOut === 1 ? 'tomorrow' : `in ${d.daysOut}d`}`);
    }
    if (bits.length) {
      out.push({ key: `morning:${date}`, title: 'Morning briefing', body: bits.join(' · '), data: { kind: 'morning' } });
    }
  }

  const hud = (await syncedRows('hud_state').catch(() => []))[0];

  // Morning routine falling behind — 2pm–6pm ET.
  if (hud && hour >= 14 && hour < 18) {
    const done = asObject(hud.morning_routine_done, {});
    const routine = asObject(hud.morning_routine, []);
    const items = (Array.isArray(routine) ? routine : []).map((r) => (typeof r === 'string' ? { id: r } : r));
    const doneCount = items.filter((r) => done[r.id]).length;
    if (items.length && doneCount / items.length < 0.6) {
      out.push({
        key: `routine:${date}`,
        title: 'Routine is behind',
        body: `${doneCount}/${items.length} done — the day is getting away`,
        data: { kind: 'routine' },
      });
    }
  }

  // Empire score / streak at risk — 6pm–10pm ET.
  if (hud && hour >= 18 && hour < 22 && (hud.empire_score || 0) < 75) {
    out.push({
      key: `evening:${date}`,
      title: 'Streak at risk',
      body: `Empire score ${hud.empire_score || 0}% — lock it in before midnight`,
      data: { kind: 'evening' },
    });
  }

  // Build pipeline waiting on the owner — any time. The key includes the state
  // marker so a fresh question (new comment id) or a new PR re-notifies.
  const TERMINAL = ['pushed', 'failed', 'cancelled'];
  for (const j of await syncedRows('build_jobs').catch(() => [])) {
    if (!j.state || TERMINAL.includes(j.state)) continue;
    if (j.state === 'question') {
      out.push({
        key: `build-q:${j.issue_number}:${j.last_comment_id || 0}`,
        title: 'Claude Code needs you',
        body: `Answer the open question on #${j.issue_number}`,
        data: { kind: 'build', issue: j.issue_number },
      });
    } else if (j.state === 'pr_open') {
      out.push({
        key: `build-pr:${j.issue_number}:${j.pr_number}`,
        title: 'PR ready to merge',
        body: `#${j.pr_number} — ${j.title || 'build complete'}`,
        data: { kind: 'build', issue: j.issue_number, pr: j.pr_number },
      });
    }
  }

  return out;
}

// --- delivery --------------------------------------------------------------

async function deviceTokens() {
  const { rows } = await query('SELECT push_token FROM devices');
  return rows.map((r) => r.push_token).filter((t) => /^Expo(nent)?PushToken\[/.test(t || ''));
}

async function sendExpo(messages) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`expo push HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return Array.isArray(json.data) ? json.data : [];
}

// Drop tokens Expo reports as dead so the devices table stays clean.
async function pruneDead(tokens, tickets) {
  await Promise.all(
    tickets.map((t, i) => {
      if (t && t.status === 'error' && t.details && t.details.error === 'DeviceNotRegistered') {
        return query('DELETE FROM devices WHERE push_token = $1', [tokens[i]]).catch(() => {});
      }
      return null;
    }),
  );
}

async function seen(key) {
  const { rows } = await query('SELECT 1 FROM push_log WHERE nudge_key = $1', [key]);
  return rows.length > 0;
}

async function markSeen(key) {
  await query(
    'INSERT INTO push_log (nudge_key, sent_at) VALUES ($1, $2) ON CONFLICT (nudge_key) DO NOTHING',
    [key, Date.now()],
  );
}

// Compute the nudges that apply now and send the ones not already logged.
// `force` ignores (and does not write) push_log — used by the manual test route.
async function runNudgeCycle({ force = false } = {}) {
  const tokens = await deviceTokens();
  const nudges = await computeNudges();
  const result = { computed: nudges.map((n) => n.key), sent: [], skipped: [], devices: tokens.length };

  for (const n of nudges) {
    if (!tokens.length) { result.skipped.push(n.key); continue; }
    if (!force && (await seen(n.key))) { result.skipped.push(n.key); continue; }
    try {
      const tickets = await sendExpo([
        { to: tokens, title: n.title, body: n.body, data: n.data, priority: 'high', channelId: 'default' },
      ]);
      await pruneDead(tokens, tickets);
      if (!force) await markSeen(n.key);
      result.sent.push(n.key);
    } catch (e) {
      console.error('nudge send failed', n.key, e.message);
      result.skipped.push(n.key);
    }
  }
  return result;
}

// One "the council met" push after the nightly Empire Council. De-duped to one
// send per day via a push_log row, same as the scheduled nudges.
async function pushCouncil(dateStr, headline) {
  const key = `council:${dateStr}`;
  if (await seen(key)) return { skipped: 'already sent' };
  const tokens = await deviceTokens();
  if (!tokens.length) return { skipped: 'no devices' };
  const tickets = await sendExpo([
    {
      to: tokens,
      title: 'The council met',
      body: headline || 'New next steps for the Empire.',
      data: { kind: 'council' },
      priority: 'high',
      channelId: 'default',
    },
  ]);
  await pruneDead(tokens, tickets);
  await markSeen(key);
  return { sent: tokens.length };
}

// One-off "does push work" ping to every registered device.
async function sendTest() {
  const tokens = await deviceTokens();
  if (!tokens.length) throw new Error('no registered devices');
  const tickets = await sendExpo([
    { to: tokens, title: 'Empire OS', body: 'Test nudge — push notifications are wired up.', data: { kind: 'test' }, channelId: 'default' },
  ]);
  await pruneDead(tokens, tickets);
  return { devices: tokens.length };
}

module.exports = { runNudgeCycle, sendTest, computeNudges, pushCouncil };
