// J.A.R.V.I.S.'s [REDEPLOY] and A.R.A.'s "it's live" report (see boot.js).
//
// requestRedeploy(): leaves a marker in app_settings (`redeploy_pending`: when,
// who, the commit it's leaving), asks GitHub to start the outside check
// (.github/workflows/server-check.yml — a few minutes later it hits /health and
// fails, which emails him, if the server didn't come back on new code), then
// exits with 75 so boot.js pulls main and restarts onto it.
//
// onBoot(): on the way up, if there's a marker — or boot.js had to fall back —
// A.R.A. tells him on Telegram: live or not, how long it took, what's running,
// what changed since the last version.
const { getSetting, setSetting } = require('./syncStore');

const RESTART_CODE = 75;
const BOOTED_AT = Date.now();

function codeInfo() {
  return {
    sha: process.env.EMPIRE_CODE_SHA || null,
    source: process.env.EMPIRE_CODE_SOURCE || 'unsupervised',
    supervised: process.env.EMPIRE_SUPERVISED === '1',
    booted_at: BOOTED_AT,
    fell_back: !!process.env.EMPIRE_FALLBACK_ERROR,
  };
}

function publicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const d = String(process.env.REPLIT_DOMAINS || '').split(',')[0].trim();
  return d ? `https://${d}` : null;
}

async function startOutsideCheck(since) {
  const url = publicUrl();
  if (!url) return 'no outside check (set PUBLIC_URL on the server for it)';
  if (!process.env.GITHUB_TOKEN) return 'no outside check (no GITHUB_TOKEN)';
  try {
    const { gh, REPO } = require('./buildAgent');
    await gh(`/repos/${REPO.owner}/${REPO.repo}/dispatches`, { method: 'POST', body: { event_type: 'server-redeploy', client_payload: { url, since } } });
    return 'outside check armed — if the server isn\'t back in ~6 minutes, GitHub emails you';
  } catch (e) {
    return `outside check couldn't start (${e.message})`;
  }
}

// Persona jobs running right now (clip scans, edits, research…): the receipt says which, and
// that they pick up again after the restart (server/jobProgress.js recover()).
function runningJobsNote() {
  try {
    const l = require('./jobProgress').runningLines();
    return l.length ? ` Running now and cut off by the restart: ${l.join('; ')}.` : '';
  } catch { return ''; }
}

async function requestRedeploy(by = 'jarvis') {
  if (process.env.EMPIRE_SUPERVISED !== '1') {
    throw new Error('the self-updating boot isn\'t running yet — redeploy once from Replit (Deployments → Redeploy) to install it; after that I can do it from here');
  }
  // Every redeploy restarts at once, automatic ones included (owner, 2026-11-23: "I'll
  // be waiting for the persona to get back to me"). A J.A.R.V.I.S. turn it cuts off is
  // resumed once at boot (jarvisEngine.recover), and the wake-up below is skipped then.
  const at = Date.now();
  await setSetting('redeploy_pending', JSON.stringify({ at, by, from_sha: process.env.EMPIRE_CODE_SHA || null }));
  const check = await startOutsideCheck(at);
  // Let the Confirm card update and this reply go out first.
  setTimeout(() => { console.log('redeploy: exiting for boot.js to pull main'); process.exit(RESTART_CODE); }, 4000);
  return `Restarting onto the latest main now — A.R.A. will confirm in a couple of minutes when it's live. (${check})${runningJobsNote()}`;
}

async function changesSince(fromSha, toSha) {
  if (!fromSha || !toSha || fromSha === toSha || !process.env.GITHUB_TOKEN) return [];
  try {
    const { gh, REPO } = require('./buildAgent');
    const cmp = await gh(`/repos/${REPO.owner}/${REPO.repo}/compare/${fromSha}...${toSha}`);
    return (cmp.commits || []).map((c) => String(c.commit?.message || '').split('\n')[0])
      .filter((m) => m && !/^Published your App$/i.test(m)).reverse().slice(0, 12);
  } catch { return []; }
}

async function headline(sha) {
  if (!sha || !process.env.GITHUB_TOKEN) return '';
  try {
    const { gh, REPO } = require('./buildAgent');
    const c = await gh(`/repos/${REPO.owner}/${REPO.repo}/commits/${sha}`);
    return String(c.commit?.message || '').split('\n')[0].slice(0, 100);
  } catch { return ''; }
}

// Heartbeat: a minute-by-minute "still alive" in app_settings.server_heartbeat,
// marked clean on a normal shutdown. When the whole machine goes down (boot.js
// and all; Replit restarting it, usually out of memory), no restart reason ever
// reaches the next server — that's how 2026-11-22's outage went unreported. A
// heartbeat that stopped without a clean shutdown, 5+ min before this boot, is
// reported by A.R.A. and handed to the auto-fix.
const BOOT_AT = Date.now();
const VANISHED_MS = 5 * 60000;
function heartbeat() {
  const beat = (clean = false) => setSetting('server_heartbeat', JSON.stringify({ at: Date.now(), boot: BOOT_AT, sha: process.env.EMPIRE_CODE_SHA || null, clean })).catch(() => {});
  setInterval(() => beat(), 60000).unref();
  process.once('SIGTERM', () => {
    Promise.race([beat(true), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0));
  });
}
const etTime = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
// What the last heartbeat says about how the previous server ended. Pure, for the test.
function vanished(prev, now = Date.now()) {
  if (!prev || prev.clean || !prev.at || prev.boot === BOOT_AT) return null;
  const gap = now - prev.at;
  if (gap < VANISHED_MS) return null;
  return `went down without warning — the whole machine, so the watchdog couldn't report it (usually it ran out of memory and Replit restarted it). Last sign of life ${etTime(prev.at)} ET; back after about ${Math.round(gap / 60000)} min.`;
}

// The memory guard in boot.js kills the biggest helper process when the machine
// is nearly out of RAM; it leaves a line in a file, and A.R.A. tells him (at most
// every 30 min, text only — the voice is often what's short of memory).
function guardReports() {
  const file = require('path').join(require('os').tmpdir(), 'empire-memory-guard.log');
  const fs = require('fs');
  let seen = 0; let lastTold = 0; let pending = [];
  try { seen = fs.statSync(file).size; } catch { /* none yet */ }
  setInterval(() => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size > seen) {
      try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(size - seen); fs.readSync(fd, b, 0, b.length, seen); fs.closeSync(fd); pending.push(...b.toString().split('\n').filter(Boolean)); } catch { /* next time */ }
      seen = size;
      for (const l of pending) console.warn(`memory guard: ${l}`);
    }
    if (pending.length && Date.now() - lastTold > 30 * 60000) {
      const lines = pending.slice(-5).map((l) => `• ${l.replace(/^\S+ /, '')}`).join('\n');
      pending = [];
      lastTold = Date.now();
      require('./telegram').botFor('ara') && require('./telegram').botFor('ara').sendMessage(require('./telegram').OWNER_ID,
        `⚠️ The server was about to run out of memory, Mr. Burrus, so it stopped what was using the most to stay up:\n${lines}\n\nIf that was J.A.R.V.I.S. mid-job, ask him to pick it back up.`).catch((e) => {
          console.error('memory guard report failed:', e.message);
          require('./pushSender').pushAlert(`guard:${Date.now()}`, 'A.R.A. — server memory', 'The server nearly ran out of memory and stopped a process to stay up.', { kind: 'loud' }).catch(() => {});
        });
    }
  }, 30000).unref();
}

async function onBoot() {
  const info = codeInfo();
  let prevBeat = null;
  try { const raw = await getSetting('server_heartbeat', ''); prevBeat = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { prevBeat = null; }
  let pending = null;
  try {
    const raw = await getSetting('redeploy_pending', '');
    pending = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch { pending = null; }
  const fellBack = process.env.EMPIRE_FALLBACK_ERROR;
  const restarted = process.env.EMPIRE_RESTART_REASON;
  if (!pending && !fellBack && !restarted) {
    const gone = vanished(prevBeat);
    if (!gone) return;
    const what = await headline(info.sha);
    const running = `${info.source === 'github' ? 'main' : 'the bundled deploy'} @ ${info.sha || '?'}${what ? ` — "${what}"` : ''}`;
    const fixing = require('./autoFix').willTry();
    require('./talonAlerts').araNote(`⚠️ **The server ${gone.split(' — ')[0]}, Mr. Burrus — it's back up now.**\nRunning: ${running}\n\n${gone.split(' — ').slice(1).join(' — ')}\n\n${fixing ? 'J.A.R.V.I.S. has a worker looking into why; you\'ll get its fix to approve.' : 'J.A.R.V.I.S. can dig in with [SERVER_LOGS].'}`,
      `Mr. Burrus, the server went down for about ${Math.round((Date.now() - prevBeat.at) / 60000)} minutes, and it's back up now.${fixing ? ' Jarvis has a worker on it.' : ''}`, { remember: true });
    if (fixing) require('./autoFix').afterRestart('went down', `went down — ${gone}`).catch((e) => console.error('auto-fix failed:', e.message));
    return;
  }
  if (pending) await setSetting('redeploy_pending', '').catch(() => {});

  const { araNote } = require('./talonAlerts');
  const secs = pending ? Math.round((Date.now() - pending.at) / 1000) : null;
  const took = secs != null ? (secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs}s`) : '';
  const what = await headline(info.sha);
  const running = `${info.source === 'github' ? 'main' : 'the bundled deploy'} @ ${info.sha || '?'}${what ? ` — "${what}"` : ''}`;
  if (restarted && !pending && !fellBack) {
    const froze = /^froze/.test(restarted);
    araNote(`⚠️ **The server ${froze ? 'froze' : 'crashed'}, Mr. Burrus — it restarted itself and it's back up.**\nRunning: ${running}\n\nWhat happened:\n\`\`\`\n${String(restarted).slice(0, 1200)}\n\`\`\`\n${require('./autoFix').willTry() ? 'J.A.R.V.I.S. is looking into it now and will send you the fix to approve.' : 'J.A.R.V.I.S. can dig in with [SERVER_LOGS].'}`,
      `Mr. Burrus, the server ${froze ? 'froze' : 'crashed'}, so it restarted itself. It's back up now.${require('./autoFix').willTry() ? ' Jarvis is finding out why.' : ' The details are below.'}`, { remember: true });
    require('./autoFix').afterRestart(froze ? 'froze' : 'crashed', restarted).catch((e) => console.error('auto-fix failed:', e.message));
    return;
  }
  if (fellBack) {
    // A redeploy he asked for: wakeJarvis already has him look at why — no second auto-fix run.
    const woke = wakeJarvis(pending, `the redeploy did NOT take: the new code crashed on startup and the server fell back to ${running}. The error: ${String(fellBack).slice(0, 600)}`);
    const fixing = !woke && require('./autoFix').willTry();
    araNote(`⚠️ **Redeploy didn't take, Mr. Burrus.** The new code crashed on startup, so the server went back to the last version that worked — everything's still running, just not the update.\nRunning: ${running}\n\nWhat broke:\n\`\`\`\n${String(fellBack).slice(0, 900)}\n\`\`\`\n${woke || fixing ? 'J.A.R.V.I.S. is looking into it now.' : 'J.A.R.V.I.S. can file a fix ([BUILD_REQUEST]) — then redeploy again.'}`,
    `Mr. Burrus, the redeploy didn't take. The new code crashed on startup, so I put the server back on the last version that worked. Everything's still running, just not the update.${woke || fixing ? ' Jarvis is on the fix.' : " The error's below."}`, { remember: true });
    if (fixing) require('./autoFix').afterRestart('fellback', fellBack).catch((e) => console.error('auto-fix failed:', e.message));
    return;
  }
  const changes = await changesSince(pending.from_sha, info.sha);
  const same = pending.from_sha && pending.from_sha === info.sha;
  wakeJarvis(pending, `the server is live on the new code: ${running}`);
  araNote(`✅ **Server's live on the new code, Mr. Burrus**${took ? ` — back in ${took}` : ''}.\nRunning: ${running}${same ? '\n(Nothing new on main since the last version — same code, fresh restart.)' : ''}${changes.length ? `\n\nWhat's new:\n${changes.map((m) => `• ${m}`).join('\n')}` : ''}`, undefined, { remember: true });
}

// A redeploy J.A.R.V.I.S. asked for (or the app's button) usually has work
// waiting on it ("once we're on the new code I'll run the Canva batch"), so A.R.A.'s
// confirmation goes to him too and he carries on by himself; he never has to be told
// the server is back (owner, 2026-11-22). Nothing waiting → he stays quiet.
const WAKE_QUIET = /^\s*NOTHING\s*\.?\s*$/i;
function wakeJarvis(pending, what) {
  if (!pending || !['jarvis', 'app'].includes(pending.by) || process.env.REDEPLOY_WAKE === 'off') return false;
  if (!require('./jarvisEngine').enabled()) return false;
  const ask = `[SENT ON YOUR OWN — A.R.A. just confirmed the redeploy you asked for: ${what}. Mr. Burrus did not send this; it's the confirmation you were waiting on. If you told him you would carry something on once the server was back on the new code, do it now, all the way, and report the result to him. If it fell back, look at why. If nothing was waiting on this redeploy, reply with exactly NOTHING and nothing else.]`;
  // After A.R.A.'s note, so he hears hers first.
  // A turn the restart cut off is already being resumed (recover) — that one carries
  // on; a second wake-up turn on top of it was the "loop".
  setTimeout(() => {
    if (require('./jarvisEngine').isBusy()) return console.log('redeploy wake: skipped, his cut-off turn is already resuming');
    require('./routes/telegram').jarvisOutOfBand(ask, { quiet: WAKE_QUIET }).catch((e) => console.error('redeploy wake failed:', e.message));
  }, 8000);
  return true;
}

module.exports = { runningJobsNote, heartbeat, guardReports, vanished, wakeJarvis, WAKE_QUIET, requestRedeploy, onBoot, codeInfo, publicUrl, RESTART_CODE };
