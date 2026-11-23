// node server/scripts/test-front-desk.js — a redeploy waits for J.A.R.V.I.S.'s
// running engine turn instead of cutting him off mid-turn (owner, 2026-11-23:
// "he's never supposed to be gone and yet he still leaves"). All stubbed.
const Module = require('module');
const assert = require('assert');
let busy = true, exited = null;
const settings = {};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './jarvisEngine') return { enabled: () => true, current: () => (busy ? { what: 'merge the worker branches', startedAt: Date.now() - 120000, step: 'Running: git merge' } : null),
    idle: async () => { while (busy) await new Promise((r) => setTimeout(r, 20)); return true; } };
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  return load.call(this, req, parent, ...rest);
};
process.env.EMPIRE_SUPERVISED = '1';
delete process.env.GITHUB_TOKEN;
const realExit = process.exit, realTimeout = global.setTimeout;
process.exit = (c) => { exited = c; };
const { requestRedeploy, RESTART_CODE } = require('../redeploy');
(async () => {
  const text = await requestRedeploy('jarvis');
  assert.match(text, /as soon as J\.A\.R\.V\.I\.S\. finishes the turn he's on \("merge the worker branches"\)/);
  await new Promise((r) => realTimeout(r, 100));
  assert.strictEqual(settings.redeploy_pending, undefined, 'nothing marked while he is mid-turn');
  assert.strictEqual(exited, null, 'no restart while he is mid-turn');
  busy = false;
  await new Promise((r) => realTimeout(r, 4300));
  assert.strictEqual(JSON.parse(settings.redeploy_pending).by, 'jarvis');
  assert.strictEqual(exited, RESTART_CODE, 'restarts once his turn ended');
  // Free → restarts right away.
  exited = null;
  assert.match(await requestRedeploy('feature'), /now/);
  assert.strictEqual(JSON.parse(settings.redeploy_pending).by, 'feature');
  console.log('front desk: all checks passed');
  realExit(0);
})().catch((e) => { console.error(e); realExit(1); });
