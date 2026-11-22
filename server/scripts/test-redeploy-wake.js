// node server/scripts/test-redeploy-wake.js — after a redeploy he asked for, A.R.A.'s
// confirmation wakes J.A.R.V.I.S. to carry on; others' redeploys and "NOTHING" stay quiet.
const Module = require('module');
const assert = require('assert');
const woke = [];
const stubs = {
  './jarvisEngine': { enabled: () => true },
  './routes/telegram': { jarvisOutOfBand: async (t, o) => { woke.push({ t, o }); return true; } },
};
const load = Module._load;
Module._load = function (req, parent, ...rest) { if (stubs[req]) return stubs[req]; if (req === './syncStore') return { getSetting: async () => '', setSetting: async () => {} }; return load.call(this, req, parent, ...rest); };
const realTimeout = global.setTimeout; global.setTimeout = (fn) => fn();
const R = require('../redeploy');
(async () => {
  assert.strictEqual(R.wakeJarvis({ by: 'jarvis' }, 'the server is live on main @ abc'), true);
  assert.match(woke[0].t, /live on main @ abc/); assert.match(woke[0].t, /NOTHING/);
  assert.ok(R.wakeJarvis({ by: 'app' }, 'x'));
  assert.strictEqual(R.wakeJarvis({ by: 'ara' }, 'x'), false, 'her redeploy has no J.A.R.V.I.S. work waiting');
  assert.strictEqual(R.wakeJarvis(null, 'x'), false, 'a crash restart is not a redeploy');
  assert.ok(R.WAKE_QUIET.test('NOTHING') && R.WAKE_QUIET.test(' nothing. ') && !R.WAKE_QUIET.test('Nothing was waiting, but…'));
  global.setTimeout = realTimeout;
  console.log('redeploy wake: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
