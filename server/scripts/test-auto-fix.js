// node server/scripts/test-auto-fix.js — the auto-fix's gating and reply parsing,
// and the Claude CLI cap (claudeSub.cliSlot) that keeps the machine's RAM in hand.
process.env.AUTO_FIX_GAP_H = '6';
const assert = require('assert');
// Stubs for the finish() path: Telegram, GitHub, the Confirm card table.
const Module = require('module');
const sent = [], cards = [], prs = [];
const realLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './telegram') return { OWNER_ID: 1, botFor: () => ({ isConfigured: () => true, sendMessage: async (c, t, o) => { sent.push({ t, o }); } }) };
  if (req === './buildAgent') return { REPO: { owner: 'o', repo: 'r' }, gh: async (p, o) => { prs.push({ p, o }); return { number: 42, html_url: 'https://github.com/o/r/pull/42' }; } };
  if (req === './db') return { query: async (q, v) => { cards.push(v); return { rows: [] }; } };
  if (req === './syncStore') return { getSetting: async () => '', setSetting: async () => {} };
  return realLoad.call(this, req, parent, ...rest);
};
const { signature, shouldRun, parseReply, prompt } = require('../autoFix');

const a = 'froze — stopped answering for 2 min (server memory 495 MB; machine 114 MB free of 1968 MB).\nLast output:\nserver stalled: event loop 10s late';
const b = a.replace('495', '610').replace('114', '90').replace('10s', '12s');
assert.strictEqual(signature(a), signature(b), 'same incident, different numbers → same signature');
assert.notStrictEqual(signature(a), signature('crashed (exit 1). Last output:\nTypeError: x is not a function'));

const now = Date.now();
assert.ok(shouldRun({}, 's', now));
assert.ok(!shouldRun({ last_at: now - 3600000, sig: 'x' }, 's', now), 'within the 6 h gap');
assert.ok(!shouldRun({ last_at: now - 7 * 3600000, sig: 's' }, 's', now), 'same incident within a day');
assert.ok(shouldRun({ last_at: now - 7 * 3600000, sig: 'x' }, 's', now), 'a new incident after the gap');

let r = parseReply('It was the CLI cap.\n\nAUTOFIX_TITLE: Cap Claude CLI processes');
assert.deepStrictEqual(r, { branch: "", title: 'Cap Claude CLI processes', body: 'It was the CLI cap.' });
r = parseReply('Load spike, nothing to change.\nAUTOFIX_BRANCH: none');
assert.strictEqual(r.branch, '');
assert.ok(/Never touch main/.test(prompt('froze', a, 'abc123')));
assert.strictEqual(parseReply('x\nAUTOFIX_TITLE: none').title, '');

// A heartbeat that stopped without a clean shutdown, 5+ min ago, is a silent outage.
{
  const { vanished } = require('../redeploy');
  const t = Date.now();
  assert.match(vanished({ at: t - 20 * 60000, boot: 1 }, t) || '', /went down without warning.*about 20 min/);
  assert.strictEqual(vanished({ at: t - 20 * 60000, boot: 1, clean: true }, t), null, 'a clean shutdown is no outage');
  assert.strictEqual(vanished({ at: t - 2 * 60000, boot: 1 }, t), null, 'a quick restart (a Publish) stays quiet');
  assert.strictEqual(vanished(null, t), null);
}

(async () => {
  const { finish } = require('../autoFix');
  // A pushed fix → PR from the worker's branch + a one-tap Merge card.
  assert.strictEqual(await finish({ id: '9', title: 'Auto-fix: server froze', status: 'done', branch: 'worker/9-auto-fix', pushed: 'pushed `worker/9-auto-fix` (1 commit(s) ahead of main)', result: 'DONE\nThe CLI had no cap.\nAUTOFIX_TITLE: Cap the CLI', issueUrl: 'https://github.com/o/r/issues/9' }), true);
  assert.strictEqual(prs[0].o.body.head, 'worker/9-auto-fix');
  assert.strictEqual(cards[0][2], 'autofix_merge');
  assert.match(sent[0].t, /The CLI had no cap/);
  assert.match(sent[1].o.reply_markup.inline_keyboard[0][0].callback_data, /^ok:/);
  // Nothing pushed → just the report, no card.
  await finish({ id: '10', title: 'Auto-fix: server crashed', status: 'done', branch: 'worker/10', pushed: 'no commits', result: 'DONE\nProvider outage.\nAUTOFIX_TITLE: none' });
  assert.match(sent[2].t, /nothing to merge/);
  assert.strictEqual(cards.length, 1);
  process.env.CLAUDE_CLI_MAX = '2'; process.env.CLAUDE_CLI_MIN_FREE_MB = '1';
  const { cliSlot, cliLoad } = require('../claudeSub');
  const r1 = await cliSlot(), r2 = await cliSlot();
  assert.strictEqual(cliLoad().cli.running, 2);
  const third = cliSlot({ waitMs: 2000 });
  setTimeout(r1, 100);
  const r3 = await third;
  await assert.rejects(cliSlot({ waitMs: 200 }), /server busy/);
  r2(); r3();
  assert.strictEqual(cliLoad().cli.running, 0);
  // Heavy pool (engine + workers) is separate, and a stop while waiting drops out of line.
    const h1 = await cliSlot({ pool: 'heavy' });
  const c1 = await cliSlot();
  assert.deepStrictEqual([cliLoad().heavy.running, cliLoad().cli.running], [1, 1], 'pools counted apart');
  const ctrl = new AbortController();
  const h2 = cliSlot({ pool: 'heavy', signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(h2, /cancelled/);
  assert.strictEqual(cliLoad().heavy.waiting, 0);
  h1(); c1();
  process.env.CLAUDE_CLI_MIN_FREE_MB = String(1e9);
  await assert.rejects(cliSlot({ waitMs: 300 }), /server busy/, 'low memory holds a new CLI back');
  console.log('test-auto-fix: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
