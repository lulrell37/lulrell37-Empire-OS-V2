// Personas ask J.A.R.V.I.S. for what they're missing (owner's idea, 2026-11-22).
//
// A.R.A. kept giving him wrong answers about his calendar until J.A.R.V.I.S. put
// the live calendar in front of her every turn; the same thing happened with the
// weather. So: when a persona is asked for something in its OWN lane and it
// doesn't have the tool or data to answer right, it says so plainly (never
// guesses) and emits [NEED_FEATURE: what it couldn't do | what he asked]. That
// starts one of J.A.R.V.I.S.'s code workers (its own Claude Code on a GitHub
// runner, server/workers.js) to build it the way the code already does things.
//
// Fully automatic (owner, 2026-11-22: "they don't answer me, they go straight to
// him, he does it, it gets put in the code and updates everything, then they
// come back to me"): the persona only says one line ("getting that built, I'll
// come back with it"); when the worker reports, finish() opens the PR, merges it
// into main and redeploys the server; on the way back up followUps() runs that
// persona's turn on his original question, with the new ability, and sends the
// answer on its bot. Exceptions that still get his one-tap Merge card instead:
// a PR touching trading, money or the workflows (GUARDED). An app-only change
// ships in the next APK, and the persona says so. Nothing built → the persona
// comes back and says why.
//
// Guards: only on his own message (not relays, loops or the council); something
// another persona owns goes to them with [RELAY_TO] instead; the same ask from
// the same persona within 7 days isn't filed twice; at most FEATURE_REQ_PER_DAY
// (5) a day. State: app_settings.feature_requests. FEATURE_REQUESTS=off stops it.
// `node server/scripts/test-feature-requests.js`.
const { getSetting, setSetting } = require('./syncStore');

const enabled = () => process.env.FEATURE_REQUESTS !== 'off';
const PER_DAY = () => Number(process.env.FEATURE_REQ_PER_DAY) || 5;
const SAME_MS = 7 * 24 * 3600e3;

const words = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3));
// Two asks are "the same" when most of their meaningful words match.
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.6;
}

// Pure: should this ask be filed? Returns null (file it) or the reason not to.
function refuse(list, { persona, need }, now = Date.now()) {
  const recent = list.filter((r) => now - r.at < SAME_MS);
  const dup = recent.find((r) => r.persona === persona && similar(r.need, need));
  if (dup) return `already asked J.A.R.V.I.S. for this${dup.worker ? ` (worker #${dup.worker})` : ''}`;
  if (recent.filter((r) => now - r.at < 24 * 3600e3).length >= PER_DAY()) return `${PER_DAY()} build requests already went to J.A.R.V.I.S. today`;
  return null;
}

function task(persona, name, need, asked) {
  return `[CAPABILITY REQUEST — ${name} (persona id "${persona}") couldn't do something in her/his own lane and asked J.A.R.V.I.S. to make it possible. When you report DONE with commits, it is merged into main and goes live AUTOMATICALLY, with no review — so build it carefully and run the tests. Anything touching trading, money or the workflows waits for his tap instead.]

What ${name} couldn't do: ${need}
What Mr. Burrus asked${asked ? `: "${String(asked).slice(0, 1500)}"` : ' (not recorded)'}

Build it so ${name} answers this kind of question right from now on, on Telegram (server/) and in the app (src/) when the persona is there too:
- Follow how the code already does it. Model: A.R.A.'s calendar — \`calendarBlock\` in server/personaRuntime.js and its mirror in \`buildSys\` (src/services/aiService.js) put the live data in her prompt every turn, with a rule to answer from it. When the data or tool already exists somewhere (a tag, a module), wire it in rather than writing a second one. Read AGENTS.md first.
- Keep it to this capability. No unrelated changes. Don't give a persona something another persona owns.
- Add or extend a test under server/scripts/, run it and the tests you touched, update AGENTS.md, commit.
- If it can't or shouldn't be built (needs a paid service or a secret he must add, belongs to another persona, already exists and the persona just didn't use it), change nothing, or the smallest prompt fix, and say what's needed.

Your report is for Mr. Burrus, short and plain: what ${name} can do now, what changed, the proof (test output). Then, on its own line at the very end:
AUTOFIX_TITLE: <one-line PR title, or none if you changed nothing>`;
}

async function load() {
  try { const raw = await getSetting('feature_requests', '[]'); return (typeof raw === 'string' ? JSON.parse(raw) : raw) || []; } catch { return []; }
}

// The tag. Returns the line the persona sees (and turns into her reply).
async function request(persona, arg, { asked = '', name, from = 'telegram' } = {}) {
  if (!enabled()) return 'NEED_FEATURE: build requests are switched off (FEATURE_REQUESTS=off) — tell him plainly you can\'t do it yet.';
  if (!asked) return 'NEED_FEATURE: not filed — only his own message can start a build request.';
  const [need, why] = String(arg || '').split('|').map((x) => x.trim());
  if (!need) return 'NEED_FEATURE needs what you couldn\'t do: [NEED_FEATURE: what you couldn\'t do | what he asked]';
  const list = await load();
  const no = refuse(list, { persona, need });
  if (no) return `NEED_FEATURE: not filed again — ${no}. Tell him in one line it's being built and you'll come back with the answer.`;
  const label = name || (require('./personas').ROSTER[persona] || {}).name || persona.toUpperCase();
  const w = await require('./workers').start({ kind: 'code', title: `Give ${label}: ${need}`.slice(0, 80), task: task(persona, label, need, why || asked), purpose: 'feature' });
  list.push({ at: Date.now(), persona, need, asked: String(asked).slice(0, 2000), from, worker: w.id, state: 'building' });
  await save(list);
  return `NEED_FEATURE: ✓ J.A.R.V.I.S.'s worker #${w.id} is building it ("${need}"). When it's built it goes into the code and live on its own, and then you come back to him with the answer. Reply with ONE short line only — that you're getting that set up and will come back with the answer — and don't guess the answer now.`;
}
const save = (list) => setSetting('feature_requests', JSON.stringify(list.slice(-50)));

// Trading, money and the workflows: never merged without his tap.
const GUARDED = /^server\/(talon|tradeLocker|tradeJournal|marketStructure|newsWire|atlasInvest|moneyWatch|siteDesk|scoutOutreach|auth|boot)|^src\/services\/tradeLocker|^\.github\//;

async function prFiles(n) {
  const { gh, REPO } = require('./buildAgent');
  return gh(`/repos/${REPO.owner}/${REPO.repo}/pulls/${n}/files?per_page=100`).then((f) => f.map((x) => x.filename)).catch(() => null);
}

// Worker reported. Returns true (handled here).
async function finish(w) {
  const af = require('./autoFix');
  const list = await load();
  const entry = list.find((r) => String(r.worker) === String(w.id)) || {};
  const done = (state, extra = {}) => { Object.assign(entry, { state, ...extra }); return save(list); };
  const { title, body } = af.parseReply(w.result);
  const comeBack = (note) => (entry.persona ? followUp(entry, note) : af.send(`🛠 ${w.title}\n\n${note}`));
  if (w.status === 'stopped') {
    await done('stopped');
    return comeBack('The build was stopped before it finished, so you still don\'t have it').then(() => true);
  }
  if (w.status !== 'done' || !/pushed/.test(w.pushed || '') || !title) {
    await done('not built');
    return comeBack(`J.A.R.V.I.S.'s worker couldn't build it${w.status !== 'done' ? ` (${w.status})` : ''}. Its report: ${body.slice(0, 1200)}${w.issueUrl ? ` (${w.issueUrl})` : ''}`).then(() => true);
  }
  let pr;
  try { pr = await af.openPR(w.branch, title, body); } catch (e) {
    await done('not merged');
    return comeBack(`J.A.R.V.I.S. built it on ${w.branch}, but the pull request couldn't be opened: ${e.message.slice(0, 200)}`).then(() => true);
  }
  const files = (await prFiles(pr.number)) || [];
  if (!files.length || files.some((f) => GUARDED.test(f))) {
    await done('waiting for his tap', { pr: pr.number });
    await af.finish(w, 'Build request'); // the one-tap Merge card: it touches trading/money/workflows
    return true;
  }
  const { gh, REPO } = require('./buildAgent');
  try {
    const r = await gh(`/repos/${REPO.owner}/${REPO.repo}/pulls/${pr.number}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
    if (!r || !r.merged) throw new Error((r && r.message) || 'GitHub refused the merge');
  } catch (e) {
    await done('not merged', { pr: pr.number });
    return comeBack(`J.A.R.V.I.S. built it (PR #${pr.number}, ${pr.url}) but merging it failed: ${e.message.slice(0, 200)}`).then(() => true);
  }
  const server = files.some((f) => f.startsWith('server/'));
  const app = files.some((f) => f.startsWith('src/') || /^(App\.js|app\.json|package\.json)$/.test(f));
  console.log(`feature requests: PR #${pr.number} merged (${server ? 'server' : ''}${app ? ' app' : ''})`);
  af.send(`🛠 Built and merged for ${entry.persona ? (require('./personas').ROSTER[entry.persona] || {}).name || entry.persona : 'a persona'}: ${title} (PR #${pr.number}, ${pr.url})${server ? '. Redeploying the server now.' : ''}${app ? ' The app part arrives in the next APK (building now).' : ''}`).catch(() => {});
  if (server && process.env.EMPIRE_SUPERVISED === '1') {
    await done('merged, going live', { pr: pr.number, merged_at: Date.now(), app });
    await require('./redeploy').requestRedeploy('jarvis'); // exits; followUps() answers him after the restart
    return true;
  }
  await done('answered', { pr: pr.number, merged_at: Date.now(), app });
  await followUp(entry, server
    ? `It's merged (PR #${pr.number}) but the server couldn't redeploy itself, so it isn't live yet: J.A.R.V.I.S. can [REDEPLOY].`
    : `It's built and merged (PR #${pr.number}); it's an app change, so it works once the new APK is on his phone (the build has started).`);
  return true;
}

// The persona comes back to him with the answer he asked for. Resolves true once
// it went out; tries again after 2 and 10 min if it didn't.
async function followUp(entry, note = '', waits = [2 * 60e3, 10 * 60e3]) {
  for (let i = 0; ; i++) {
    const ok = await sendFollowUp(entry, note);
    if (ok) return true;
    if (i >= waits.length) {
      console.error(`feature requests failed: couldn't come back to him about "${entry.need}" (${entry.persona})`);
      const name = (require('./personas').ROSTER[entry.persona] || {}).name || entry.persona;
      await require('./loud').tellAra(`feature:${entry.worker}`, `${name} couldn't get back to you about "${String(entry.asked).slice(0, 200)}". Where it stands: ${note || 'J.A.R.V.I.S. built it and it is live, so ask again and the answer should be right now.'}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, waits[i]));
  }
}
function sendFollowUp(entry, note = '') {
  const ask = `[SENT ON YOUR OWN — Mr. Burrus did not send this. Earlier he asked you: "${entry.asked}". You didn't have what you needed ("${entry.need}"), so you asked J.A.R.V.I.S. to build it. Where it stands: ${note ? `${note}.` : 'built and live now — you have it in front of you this turn.'} Come back to him now: open with a few words that you're following up on what he asked, then answer it properly${note && !/live now/.test(note) ? ' as far as you can, and say what is still missing' : ''}.]`;
  return require('./routes/telegram').personaOutOfBand(entry.persona, ask).then((ok) => ok !== false).catch((e) => { console.error(`feature requests failed: follow-up: ${e.message}`); return false; });
}

// At boot: requests whose merge this restart put live get their answer now.
async function followUps(opts = {}) {
  if (!enabled()) return;
  const list = await load();
  const due = list.filter((r) => r.state === 'merged, going live' && r.merged_at && Date.now() - r.merged_at < 3 * 3600e3);
  // The new code crashed on startup and the server went back to the old one: it isn't live.
  const fellBack = process.env.EMPIRE_FALLBACK_ERROR;
  for (const r of due) {
    r.state = 'answering';
    await save(list);
    const note = fellBack
      ? `It was built and merged (PR #${r.pr}), but the new code crashed on startup, so the server went back to the old version and it is NOT live yet; the auto-fix is on it. Don't answer from it`
      : (r.app ? 'It is live on the server now; the app part arrives with the next APK' : '');
    const ok = await followUp(r, note, opts.waits);
    r.state = ok ? (fellBack ? 'merged, not live' : 'answered') : 'follow-up failed';
    await save(list);
  }
}

// He tapped Merge on a guarded one (autoFix.mergeFix): answer him after the redeploy.
async function onTapMerged(prNumber, { willRedeploy }) {
  const list = await load();
  const r = list.find((x) => x.pr === prNumber && x.state === 'waiting for his tap');
  if (!r) return;
  Object.assign(r, { state: willRedeploy ? 'merged, going live' : 'answered', merged_at: Date.now() });
  await save(list);
  if (!willRedeploy) await followUp(r, `It's merged (PR #${prNumber}); it's an app change, so it works once the new APK is on his phone`);
}

module.exports = { request, finish, followUps, onTapMerged, refuse, similar, task, enabled, GUARDED };
