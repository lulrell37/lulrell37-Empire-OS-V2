// node server/scripts/test-auto-fix.js — the auto-fix's gating and reply parsing,
// and the Claude CLI cap (claudeSub.cliSlot) that keeps the machine's RAM in hand.
process.env.AUTO_FIX_GAP_H = '6';
const assert = require('assert');
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

let r = parseReply('It was the CLI cap.\n\nAUTOFIX_BRANCH: autofix/cli-cap\nAUTOFIX_TITLE: Cap Claude CLI processes');
assert.deepStrictEqual(r, { branch: 'autofix/cli-cap', title: 'Cap Claude CLI processes', body: 'It was the CLI cap.' });
r = parseReply('Load spike, nothing to change.\nAUTOFIX_BRANCH: none');
assert.strictEqual(r.branch, '');
assert.ok(/Never push to main/.test(prompt('froze', a, 'abc123')));

(async () => {
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
  process.env.CLAUDE_HEAVY_MAX = '1';
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
