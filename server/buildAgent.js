// J.A.R.V.I.S. -> Claude Code, from the server. Server-side twin of the app's
// src/services/buildAgent.js + buildJobs.js, so the build loop works over
// Telegram too: a spec becomes a GitHub issue with "@claude" in it, the repo's
// .github/workflows/claude.yml runs Claude Code on it (branch + PR), and a merge
// into main starts the APK build (.github/workflows/build.yml).
//
// Needs GITHUB_TOKEN on the server — the same fine-grained PAT the app keeps in
// Settings › Dev (Issues + Pull requests + Contents read/write on the repo).
//
// Jobs are the app's own synced `build_jobs` rows (id `owner/repo#issue`), so a
// build filed from Telegram shows up on the app's build board and the app's
// poller follows it as well. This side's poller only tells Mr. Burrus on
// J.A.R.V.I.S.'s Telegram bot when a job asks a question, opens a PR, fails or
// ships; what it has already told him is kept in `build_tg_seen` (app_settings),
// so the app moving a job's state first never swallows the message.
const { syncedRows, upsertSyncRow, getSetting, setSetting } = require('./syncStore');

const REPO = { owner: 'lulrell37', repo: 'lulrell37-Empire-OS-V2' };
const API = 'https://api.github.com';
const CLAUDE_AUTHORS = ['github-actions[bot]', 'claude[bot]', 'claude'];
const rp = (r) => `/repos/${r.owner}/${r.repo}`;
const jobId = (n, r = REPO) => `${r.owner}/${r.repo}#${n}`;

const configured = () => !!process.env.GITHUB_TOKEN;

async function gh(path, { method = 'GET', body } = {}) {
  if (!configured()) throw new Error('GITHUB_TOKEN is not set on the server');
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`GitHub: ${String(json.message || text || res.status).slice(0, 180)}`);
  return json;
}

async function fileBuildRequest(spec, { projectName = null } = {}) {
  const clean = String(spec || '').trim();
  if (!clean) throw new Error('empty build spec');
  const first = clean.split('\n')[0].trim();
  const issue = await gh(`${rp(REPO)}/issues`, { method: 'POST', body: {
    title: (first.length > 90 ? first.slice(0, 87) + '…' : first) || 'Build request from Empire OS',
    body: `@claude\n\n${clean}\n\nImplement this on a branch and open a pull request that closes this issue. If anything is ambiguous, ask here before writing code.\n\n<!-- filed by Empire OS (Telegram) -->`,
  } });
  const now = Date.now();
  await upsertSyncRow('build_jobs', jobId(issue.number), {
    id: jobId(issue.number), repo_owner: REPO.owner, repo_name: REPO.repo, issue_number: issue.number,
    pr_number: null, spec: clean, state: 'queued', question: null, last_comment_id: 0,
    title: issue.title, project_name: projectName, created_at: now, updated_at: now,
  });
  return { issueNumber: issue.number, url: issue.html_url, title: issue.title };
}

async function jobFor(n) {
  return (await syncedRows('build_jobs').catch(() => [])).find((j) => Number(j.issue_number) === Number(n) && (j.repo_name || REPO.repo) === REPO.repo) || null;
}
async function patchJob(n, patch) {
  const cur = await jobFor(n);
  if (!cur) return;
  await upsertSyncRow('build_jobs', cur.id || jobId(n), { ...cur, ...patch, updated_at: Date.now() });
}

async function replyToBuild(n, text) {
  await gh(`${rp(REPO)}/issues/${n}/comments`, { method: 'POST', body: { body: `@claude ${String(text).trim()}` } });
  await patchJob(n, { state: 'working', question: null });
}

// Same matching as the app: a `…issue-<n>-…` head branch or "#<n>" in the body.
async function findLinkedPR(n) {
  const prs = await gh(`${rp(REPO)}/pulls?state=all&per_page=50&sort=created&direction=desc`);
  const pr = prs.find((p) => String((p.head && p.head.ref) || '').includes(`issue-${n}-`) || String(p.body || '').includes(`#${n}`));
  return pr ? prInfo(pr) : null;
}
// The Action pushes a `claude/issue-<n>-…` branch without a PR when it runs on
// an issue — open the PR for it (only if the branch is ahead), same as the app.
async function openPRForIssue(n) {
  const branches = await gh(`${rp(REPO)}/branches?per_page=100`);
  const br = branches.find((b) => b.name.includes(`issue-${n}-`));
  if (!br) return null;
  const cmp = await gh(`${rp(REPO)}/compare/main...${encodeURIComponent(br.name)}`).catch(() => null);
  if (!cmp || !cmp.ahead_by) return null;
  const issue = await gh(`${rp(REPO)}/issues/${n}`);
  try {
    return prInfo(await gh(`${rp(REPO)}/pulls`, { method: 'POST', body: { title: issue.title || `Build request #${n}`, head: br.name, base: 'main', body: `Implements #${n}.\n\nCloses #${n}` } }));
  } catch (e) {
    if (/pull request already exists/i.test(e.message)) return findLinkedPR(n);
    throw e;
  }
}
const prInfo = (pr) => ({ prNumber: pr.number, title: pr.title, state: pr.state, merged: !!(pr.merged || pr.merged_at), url: pr.html_url });

// Merge a build's PR into main (squash) — that push starts the APK build.
async function mergeBuild(n) {
  const job = await jobFor(n);
  let pr = job && job.pr_number ? prInfo(await gh(`${rp(REPO)}/pulls/${job.pr_number}`)) : null;
  if (!pr) pr = (await findLinkedPR(n)) || (await openPRForIssue(n));
  if (!pr) throw new Error(`no pull request for #${n} yet — Claude Code is still working on it`);
  if (pr.merged) { await patchJob(n, { pr_number: pr.prNumber, state: 'pushed' }); return `PR #${pr.prNumber} was already merged`; }
  const r = await gh(`${rp(REPO)}/pulls/${pr.prNumber}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  if (!r.merged) throw new Error(r.message || 'GitHub refused the merge');
  await patchJob(n, { pr_number: pr.prNumber, state: 'pushed' });
  return `PR #${pr.prNumber} merged into main — the APK build is starting (${pr.url})`;
}

async function cancelBuild(n) {
  const job = await jobFor(n);
  if (job && job.pr_number) await gh(`${rp(REPO)}/pulls/${job.pr_number}`, { method: 'PATCH', body: { state: 'closed' } }).catch(() => {});
  await gh(`${rp(REPO)}/issues/${n}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
  await patchJob(n, { state: 'cancelled' });
  return `build #${n} cancelled`;
}

// --- poller ------------------------------------------------------------------

const isFailure = (b) => /claude encountered an error|reached maximum number of turns|execution failed|\berror after \d/i.test(String(b || ''));
const isQuestion = (b) => !/github\.com\/[^\s]+\/pull\/\d+/.test(b) && !isFailure(b) && String(b || '').includes('?');

// One pass over open jobs. Returns [{ n, kind, text }] for each new thing to
// tell him; marks each one seen so it's said once.
async function pollBuildJobs() {
  if (!configured()) return [];
  const jobs = (await syncedRows('build_jobs').catch(() => []))
    .filter((j) => (j.repo_name || REPO.repo) === REPO.repo && j.issue_number && !['pushed', 'failed', 'cancelled'].includes(j.state));
  if (!jobs.length) return [];
  let seen = {};
  try { seen = JSON.parse(await getSetting('build_tg_seen', '{}')) || {}; } catch { seen = {}; }
  const out = [];
  const say = (n, kind, key, text) => { if (seen[n] === key) return; seen[n] = key; out.push({ n, kind, text }); };

  for (const j of jobs) {
    const n = j.issue_number;
    try {
      const comments = await gh(`${rp(REPO)}/issues/${n}/comments?per_page=100`);
      const last = comments.filter((c) => CLAUDE_AUTHORS.includes(String(c.user && c.user.login).toLowerCase()) && String(c.body || '').trim()).pop();
      let pr = j.pr_number ? prInfo(await gh(`${rp(REPO)}/pulls/${j.pr_number}`)) : null;
      if (!pr) pr = (await findLinkedPR(n).catch(() => null)) || (await openPRForIssue(n).catch(() => null));

      if (pr && pr.merged) {
        await patchJob(n, { pr_number: pr.prNumber, state: 'pushed' });
        say(n, 'pushed', `pushed:${pr.prNumber}`, `Build #${n} shipped — PR #${pr.prNumber} merged into main, APK build started.`);
      } else if (pr && pr.state === 'closed') {
        await patchJob(n, { pr_number: pr.prNumber, state: 'failed' });
        say(n, 'failed', `closed:${pr.prNumber}`, `Build #${n}: PR #${pr.prNumber} was closed without merging.`);
      } else if (pr) {
        await patchJob(n, { pr_number: pr.prNumber, state: 'pr_open', question: null });
        say(n, 'pr_open', `pr:${pr.prNumber}`, `Build #${n} is ready — PR #${pr.prNumber}: "${pr.title}" ${pr.url}\nSay the word and I'll merge it and start the APK build.`);
      } else if (last && isFailure(last.body)) {
        await patchJob(n, { state: 'failed' });
        say(n, 'failed', `fail:${last.id}`, `Build #${n}: Claude Code stopped before finishing (likely ran out of turns). Re-file it — smaller if it was a big one.`);
      } else if (last && isQuestion(last.body)) {
        await patchJob(n, { state: 'question', question: last.body.slice(0, 1200), last_comment_id: last.id });
        say(n, 'question', `q:${last.id}`, `Claude Code has a question on build #${n}:\n\n${last.body.trim().slice(0, 1500)}`);
      } else if (Date.now() - (j.updated_at || j.created_at || Date.now()) > 45 * 60000) {
        await patchJob(n, { state: 'failed' });
        say(n, 'failed', 'stale', `Build #${n}: no progress from Claude Code for 45+ minutes — the run likely never started or died. Check the repo's Actions tab, then re-file.`);
      } else if (last && j.state === 'queued') {
        await patchJob(n, { state: 'working' });
      }
    } catch (e) { console.error(`build poll #${n}:`, e.message); }
  }
  if (out.length) await setSetting('build_tg_seen', JSON.stringify(seen)).catch(() => {});
  return out;
}

// Cron body: poll, then tell him from J.A.R.V.I.S.'s bot (A.R.A.'s if his
// isn't set up), voice note first like every other reply, and into that
// persona's Telegram history so the next turn knows.
async function pollAndNotify() {
  const events = await pollBuildJobs();
  if (!events.length) return;
  const telegram = require('./telegram');
  const { query } = require('./db');
  const persona = telegram.botFor('jarvis') && telegram.botFor('jarvis').isConfigured() ? 'jarvis' : 'ara';
  const bot = telegram.botFor(persona);
  if (!bot || !bot.isConfigured()) return;
  for (const ev of events) {
    const { ogg } = await require('./personaVoice').voiceNote(persona, ev.text).catch(() => ({ ogg: null }));
    if (ogg) await bot.sendVoice(telegram.OWNER_ID, ogg).catch(() => {});
    await bot.sendMessage(telegram.OWNER_ID, ev.text).catch((e) => console.error('build notify failed:', e.message));
    await query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', [persona, 'assistant', ev.text, Date.now()]).catch(() => {});
  }
}

module.exports = { configured, fileBuildRequest, replyToBuild, mergeBuild, cancelBuild, pollBuildJobs, pollAndNotify, REPO };
