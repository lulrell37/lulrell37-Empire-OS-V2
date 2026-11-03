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

async function requestRedeploy(by = 'jarvis') {
  if (process.env.EMPIRE_SUPERVISED !== '1') {
    throw new Error('the self-updating boot isn\'t running yet — redeploy once from Replit (Deployments → Redeploy) to install it; after that I can do it from here');
  }
  const at = Date.now();
  await setSetting('redeploy_pending', JSON.stringify({ at, by, from_sha: process.env.EMPIRE_CODE_SHA || null }));
  const check = await startOutsideCheck(at);
  // Let the Confirm card update and this reply go out first.
  setTimeout(() => { console.log('redeploy: exiting for boot.js to pull main'); process.exit(RESTART_CODE); }, 4000);
  return `Restarting onto the latest main now — A.R.A. will confirm in a couple of minutes when it's live. (${check})`;
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

async function onBoot() {
  const info = codeInfo();
  let pending = null;
  try {
    const raw = await getSetting('redeploy_pending', '');
    pending = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch { pending = null; }
  const fellBack = process.env.EMPIRE_FALLBACK_ERROR;
  if (!pending && !fellBack) return;
  if (pending) await setSetting('redeploy_pending', '').catch(() => {});

  const { araNote } = require('./talonAlerts');
  const secs = pending ? Math.round((Date.now() - pending.at) / 1000) : null;
  const took = secs != null ? (secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs}s`) : '';
  const what = await headline(info.sha);
  const running = `${info.source === 'github' ? 'main' : 'the bundled deploy'} @ ${info.sha || '?'}${what ? ` — "${what}"` : ''}`;
  if (fellBack) {
    araNote(`⚠️ **Redeploy didn't take, Mr. Burrus.** The new code crashed on startup, so the server went back to the last version that worked — everything's still running, just not the update.\nRunning: ${running}\n\nWhat broke:\n\`\`\`\n${String(fellBack).slice(0, 900)}\n\`\`\`\nJ.A.R.V.I.S. can file a fix ([BUILD_REQUEST]) — then redeploy again.`,
    "Mr. Burrus, the redeploy didn't take. The new code crashed on startup, so I put the server back on the last version that worked. Everything's still running, just not the update. The error's below.");
    return;
  }
  const changes = await changesSince(pending.from_sha, info.sha);
  const same = pending.from_sha && pending.from_sha === info.sha;
  araNote(`✅ **Server's live on the new code, Mr. Burrus**${took ? ` — back in ${took}` : ''}.\nRunning: ${running}${same ? '\n(Nothing new on main since the last version — same code, fresh restart.)' : ''}${changes.length ? `\n\nWhat's new:\n${changes.map((m) => `• ${m}`).join('\n')}` : ''}`);
}

module.exports = { requestRedeploy, onBoot, codeInfo, RESTART_CODE };
