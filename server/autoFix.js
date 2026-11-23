// Auto-fix after the server goes down (owner's ask, 2026-11-22: "Jarvis can
// just auto find and fix the problem whenever server goes down").
//
// When boot.js restarts a child that froze or crashed, a redeploy falls back
// because the new code wouldn't start, or the whole machine went down
// (heartbeat), onBoot() calls afterRestart(). A few minutes later one of
// J.A.R.V.I.S.'s code workers (its own Claude Code on a GitHub runner — not his
// engine, so he stays free to talk) gets the incident report: find the root
// cause from the evidence, make the smallest fix on its worker/ branch, run the
// tests, commit (the job pushes the branch). When it reports, finish() opens the
// PR and sends him, on J.A.R.V.I.S.'s bot,
// what broke, the proof and the fix, with a Merge & redeploy Confirm card:
// one tap from his phone. AUTO_FIX_MERGE=on merges and redeploys with no tap.
// No code fix (out of memory from load, a provider outage, a secret) → he says
// so and what to do. At most once per AUTO_FIX_GAP_H (6) hours, and the same
// incident not twice in a day. AUTO_FIX=off stops it.
const { getSetting, setSetting } = require('./syncStore');

const GAP_MS = () => (Number(process.env.AUTO_FIX_GAP_H) || 6) * 3600000;
const DELAY_MS = () => (Number(process.env.AUTO_FIX_DELAY_S) || 180) * 1000;
const enabled = () => process.env.AUTO_FIX !== 'off';

// What identifies "the same incident": what happened + the last error-ish line.
function signature(reason) {
  const lines = String(reason || '').split('\n');
  const head = (lines[0] || '').replace(/\d+(\.\d+)?\s*(MB|min|s)\b/g, 'N').replace(/exit \d+/, 'exit N').slice(0, 60);
  const err = lines.reverse().find((l) => /error|failed|cannot|undefined|stalled/i.test(l)) || '';
  return `${head}|${err.replace(/\d+/g, 'N').slice(0, 120)}`;
}

async function loadState() {
  try { const raw = await getSetting('auto_fix', ''); return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}; } catch { return {}; }
}

// Should this incident get a run? Pure, for the test.
function shouldRun(state, sig, now = Date.now()) {
  if (state.last_at && now - state.last_at < GAP_MS()) return false;
  if (state.sig === sig && state.last_at && now - state.last_at < 24 * 3600000) return false;
  return true;
}

function prompt(kind, reason, sha) {
  return `[AUTO-FIX — sent by the server itself, not by Mr. Burrus. He is not watching; he'll read your answer on Telegram.]

The Empire OS server just ${kind === 'fellback' ? 'refused a redeploy: the new code crashed on startup, so boot.js went back to the last good copy' : 'went down and boot.js restarted it'}. It's back up now on ${sha || 'an unknown commit'}. The supervisor's report:
\`\`\`
${String(reason).slice(0, 4000)}
\`\`\`

Find out why and fix it, the way you'd fix it if he'd asked you to:
1. Evidence first. Read the code the report points at (server/, AGENTS.md has the map), git log for what changed recently. Name the root cause and the line or log that proves it. Don't guess.
2. If a code change fixes it: make the smallest change that fixes the root cause (no unrelated cleanups), run the server tests it touches (node server/scripts/test-*.js) and \`node --check\` on what you changed, and commit it on your branch. Never touch main, never merge — he approves the merge with one tap. Update AGENTS.md if you change how something works.
3. If no code change fixes it (load spike, provider outage, credits, a secret, Replit itself), change nothing and say what he should do, if anything.

Your report is for him, short and plain: what broke, the proof, what you changed (or why nothing). Then, on its own line at the very end:
AUTOFIX_TITLE: <one-line PR title, or none if you changed nothing>`;
}

function parseReply(text) {
  const t = String(text || '');
  const branch = (/^AUTOFIX_BRANCH:\s*(\S+)/m.exec(t) || [])[1] || '';
  let title = ((/^AUTOFIX_TITLE:\s*(.+)$/m.exec(t) || [])[1] || '').trim();
  if (/^none$/i.test(title)) title = '';
  const body = t.replace(/^AUTOFIX_(BRANCH|TITLE):.*$/gm, '').trim();
  return { branch: /^none$/i.test(branch) ? '' : branch, title, body };
}

async function openPR(branch, title, body) {
  const { gh, REPO } = require('./buildAgent');
  const base = `/repos/${REPO.owner}/${REPO.repo}`;
  try {
    const pr = await gh(`${base}/pulls`, { method: 'POST', body: { head: branch, base: 'main', title: title || `Auto-fix: ${branch}`, body: `${body}\n\n_Opened by J.A.R.V.I.S.'s auto-fix after a server restart._\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)` } });
    if (pr && pr.number) return { number: pr.number, url: pr.html_url };
  } catch (e) {
    // Already open for this branch? Use that one.
    const open = await gh(`${base}/pulls?head=${REPO.owner}:${encodeURIComponent(branch)}&state=open`).catch(() => []);
    if (open && open[0]) return { number: open[0].number, url: open[0].html_url };
    throw e;
  }
  throw new Error('GitHub returned no pull request');
}

// Merge the fix and go live. Used by the Confirm card (kind 'autofix_merge') and AUTO_FIX_MERGE=on.
async function mergeFix(prNumber) {
  const { gh, REPO } = require('./buildAgent');
  const base = `/repos/${REPO.owner}/${REPO.repo}`;
  const r = await gh(`${base}/pulls/${prNumber}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  if (!r || !r.merged) throw new Error((r && r.message) || 'GitHub refused the merge');
  const files = await gh(`${base}/pulls/${prNumber}/files?per_page=100`).catch(() => []);
  const serverSide = !files.length || files.some((f) => /^server\//.test(f.filename));
  const app = files.some((f) => !/^server\/|\.md$|^docs\//.test(f.filename));
  let text = `Auto-fix PR #${prNumber} merged into main.${app ? ' It touches the app too, so the APK build starts.' : ''}`;
  await require('./featureRequests').onTapMerged(prNumber, { willRedeploy: serverSide && process.env.EMPIRE_SUPERVISED === '1' }).catch(() => {});
  if (serverSide) text += ` ${await require('./redeploy').requestRedeploy('autofix')}`;
  return text;
}

async function send(text, confirm) {
  const tg = require('./telegram');
  const id = tg.botFor('jarvis') && tg.botFor('jarvis').isConfigured() ? 'jarvis' : 'ara';
  const bot = tg.botFor(id);
  if (!bot || !bot.isConfigured() || !tg.OWNER_ID) return require('./loud').tellAra(`autofix:${String(text).slice(0, 40)}`, String(text).slice(0, 1500));
  const prefix = id === 'jarvis' ? '' : 'J.A.R.V.I.S.:\n';
  await bot.sendMessage(tg.OWNER_ID, `${prefix}${text}`).catch((e) => {
    console.error('auto-fix failed: send:', e.message);
    return require('./loud').tellAra(`autofix:${String(text).slice(0, 40)}`, `J.A.R.V.I.S. couldn't send you this (${e.message.slice(0, 80)}):\n${String(text).slice(0, 1500)}`);
  });
  if (confirm) {
    await bot.sendMessage(tg.OWNER_ID, `${confirm.label}?\n\n${confirm.detail}`, {
      log: false,
      reply_markup: { inline_keyboard: [[{ text: '✅ Confirm', callback_data: `ok:${confirm.id}` }, { text: '✖ Cancel', callback_data: `no:${confirm.id}` }]] },
    }).catch((e) => console.error('auto-fix confirm card:', e.message));
  }
}

async function run(kind, reason) {
  if (!process.env.GITHUB_TOKEN) return console.log('auto-fix: no GITHUB_TOKEN, so no worker can be started — skipping');
  const sha = process.env.EMPIRE_CODE_SHA || '';
  const w = await require('./workers').start({ kind: 'code', title: `Auto-fix: server ${kind}`, task: prompt(kind, reason, sha), purpose: 'autofix' });
  console.log(`auto-fix: worker #${w.id} is looking into the restart`);
}

// The auto-fix worker reported (workers.report → onDone). Returns true: handled here.
async function finish(w, kindLabel = '') {
  const { title, body } = parseReply(w.result);
  const head = kindLabel ? `🛠 **${kindLabel} — ${w.title}** (worker #${w.id})` : `🛠 **Auto-fix — the server ${String(w.title).replace(/^Auto-fix: server /, '')}** (worker #${w.id})`;
  const report = `${head}\n\n${body.slice(0, 3000)}${w.issueUrl ? `\n\nFull report: ${w.issueUrl}` : ''}`;
  if (w.status !== 'done') { await send(`${report}\n\n⚠️ The worker didn't finish (${w.status}).`); return true; }
  if (!/pushed/.test(w.pushed || '') || !title) { await send(`${report}\n\nNo code change, so there's nothing to merge.`); return true; }
  let pr;
  try { pr = await openPR(w.branch, title, body); } catch (e) {
    console.error('auto-fix failed: PR:', e.message);
    await send(`${report}\n\n⚠️ The fix is pushed on \`${w.branch}\`, but I couldn't open the PR: ${e.message.slice(0, 200)}`);
    return true;
  }
  if (process.env.AUTO_FIX_MERGE === 'on') {
    let done;
    try { done = await mergeFix(pr.number); } catch (e) { done = `⚠️ Merging it failed: ${e.message.slice(0, 200)}`; }
    await send(`${report}\n\nPR #${pr.number}: ${pr.url}\n${done}`);
    return true;
  }
  const { query } = require('./db');
  const cid = require('crypto').randomBytes(6).toString('hex');
  const label = `Merge ${kindLabel ? 'build' : 'auto-fix'} PR #${pr.number} and ship it`;
  const detail = `${title}\n${pr.url}\nSquash-merges it into main. Server changes go live on a redeploy (the server restarts, about 2 min); app changes start the APK build.`;
  await query('INSERT INTO tg_pending (id, persona, kind, label, detail, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [cid, 'jarvis', 'autofix_merge', label, detail, JSON.stringify({ pr: pr.number }), Date.now()]);
  await send(`${report}\n\nPR #${pr.number}: ${pr.url}`, { id: cid, label, detail });
  return true;
}

// Called from onBoot() when the server came back from a freeze/crash, or fell back.
async function afterRestart(kind, reason) {
  if (!enabled() || !reason) return;
  const sig = signature(reason);
  const state = await loadState();
  if (!shouldRun(state, sig)) {
    console.log('auto-fix: ran recently or already on this incident — skipping');
    // A.R.A.'s restart note said J.A.R.V.I.S. would look; say why he isn't, rather than going quiet.
    return require('./loud').tellAra('autofix:skip', `About that restart: J.A.R.V.I.S. isn't starting another auto-fix, because ${state.sig === sig ? 'he already looked into this same problem today' : `one already ran in the last ${Math.round(GAP_MS() / 3600000)} hours`}. If it keeps happening, tell him and he'll dig in.`);
  }
  await setSetting('auto_fix', JSON.stringify({ last_at: Date.now(), sig, kind })).catch(() => {});
  setTimeout(() => {
    run(kind, reason).catch((e) => {
      console.error('auto-fix failed:', e.message);
      require('./loud').tellAra('autofix:start', `The server ${kind}, and J.A.R.V.I.S. couldn't start looking into it: ${e.message.slice(0, 200)}. Ask him to check [SERVER_LOGS].`);
    });
  }, DELAY_MS()).unref();
}

// Will a restart get looked at? (So A.R.A.'s report doesn't promise a fix that won't come.)
const willTry = () => enabled() && !!process.env.GITHUB_TOKEN && require('./workers').enabled();

module.exports = { afterRestart, willTry, finish, openPR, send, mergeFix, signature, shouldRun, parseReply, prompt };
