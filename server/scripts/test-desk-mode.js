// node server/scripts/test-desk-mode.js — every J.A.R.V.I.S. task goes to a worker
// (owner, 2026-11-23); his own jobs are small things, pushing code and redeploying.
// His engine is read-only with a short cap, a turn past it is handed to a worker,
// and [WORKER_SHIP] merges finished branches (or any branch) into main. All stubbed.
const Module = require('module');
const assert = require('assert');
const settings = {};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './db') return { query: async () => ({ rows: [] }) };
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  return load.call(this, req, parent, ...rest);
};
const W = require('../workers');
const E = require('../jarvisEngine');

(async () => {
  // The brief tells him the rule, and desk mode is on unless switched off.
  assert.ok(E.DESK());
  const brief = E.engineBrief('P', { readOnly: false, dir: '/r' });
  assert.match(brief, /READ-ONLY/);
  assert.match(brief, /\[WORKER_SHIP/);
  assert.match(brief, /pushing code/);
  assert.doesNotMatch(brief, /do code work yourself/);

  // [WORKER_SHIP]: merges finished code workers' branches; conflicts are left alone.
  const calls = [];
  settings.workers = JSON.stringify({
    7: { id: '7', kind: 'code', title: 'Weather card', status: 'done', branch: 'worker/7-weather', pushed: 'pushed', createdAt: 1 },
    8: { id: '8', kind: 'code', title: 'Clip speed', status: 'done', branch: 'worker/8-clips', pushed: 'pushed', createdAt: 2 },
    9: { id: '9', kind: 'code', title: 'Nothing', status: 'done', branch: 'worker/9-x', pushed: 'no commits', createdAt: 3 },
  });
  W._setDeps({
    repo: () => ({ owner: 'o', repo: 'r' }),
    gh: async (p, o = {}) => {
      calls.push({ p, o });
      if (/\/compare\//.test(p)) return { files: [{ filename: /weather/.test(p) ? 'server/personaRuntime.js' : 'src/x.js' }] };
      if (/\/merges$/.test(p)) {
        if (o.body.head === 'worker/8-clips') throw new Error('GitHub: Merge conflict');
        return { sha: 'abc' };
      }
      throw new Error(p);
    },
  });
  const realTimeout = global.setTimeout;
  let redeployScheduled = 0;
  global.setTimeout = (fn, ms) => { if (ms === 60000) { redeployScheduled++; return { unref() {} }; } return realTimeout(fn, ms); };
  let out = await W.tag('WORKER_SHIP', 'all');
  assert.match(out, /"Weather card": merged into main/);
  assert.match(out, /"Clip speed": NOT merged — it conflicts with main/);
  assert.doesNotMatch(out, /Nothing/, 'a worker with no commits has nothing to ship');
  assert.match(out, /server redeploys in about a minute/);
  assert.strictEqual(redeployScheduled, 1);
  assert.strictEqual(calls.filter((c) => /\/merges$/.test(c.p)).length, 2);
  // Shipped once: not again.
  out = await W.tag('WORKER_SHIP', 'all');
  assert.doesNotMatch(out, /Weather card/);
  // Any branch name ships too.
  out = await W.tag('WORKER_SHIP', 'empire-site');
  assert.match(out, /"empire-site": merged into main/);
  assert.strictEqual(calls.filter((c) => /\/merges$/.test(c.p)).pop().o.body.head, 'empire-site');
  global.setTimeout = realTimeout;

  // A turn past the desk cap goes to a worker, and he says so.
  let started = null;
  const realStart = W.start;
  require.cache[require.resolve('../workers')].exports.start = async (o) => { started = o; return { id: '12', slot: 2, status: 'running' }; };
  const reply = await E.handToWorker('[Mon 3:00 PM] fix the weather card on the app', 'Looked at weatherBlock…');
  assert.match(reply, /handed it to worker 2/);
  assert.strictEqual(started.kind, 'code');
  assert.match(started.task, /fix the weather card/);
  assert.match(started.task, /Looked at weatherBlock/);
  require.cache[require.resolve('../workers')].exports.start = realStart;

  // The gate on [WORKER_SHIP] and the no-tap [REDEPLOY] live in personaRuntime: check the source rules.
  const src = require('fs').readFileSync(require.resolve('../personaRuntime'), 'utf8');
  assert.match(src, /name === 'WORKER_SHIP' && persona === 'jarvis'[\s\S]{0,200}push\|ship\|merge/);
  assert.match(src, /name === 'REDEPLOY' && persona === 'jarvis'/);
  console.log('desk mode: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
