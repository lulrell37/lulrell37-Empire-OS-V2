// node server/scripts/test-front-desk.js — a redeploy waits for J.A.R.V.I.S.'s
// running engine turn instead of cutting him off mid-turn (owner, 2026-11-23:
// "he's never supposed to be gone and yet he still leaves"). All stubbed.
const Module = require('module');
const assert = require('assert');
let busy = true, exited = null, isStuck = false;
const settings = {};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './jarvisEngine') return { enabled: () => true, current: () => (busy ? { what: 'merge the worker branches', startedAt: Date.now() - 120000, step: 'Running: git merge' } : null),
    idle: async () => { while (busy) await new Promise((r) => setTimeout(r, 20)); return true; }, stuck: () => isStuck, isBusy: () => busy };
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  return load.call(this, req, parent, ...rest);
};
process.env.EMPIRE_SUPERVISED = '1';
delete process.env.GITHUB_TOKEN;
const realExit = process.exit, realTimeout = global.setTimeout;
process.exit = (c) => { exited = c; };
const { requestRedeploy, RESTART_CODE } = require('../redeploy');
(async () => {
  // His own tap restarts at once, even mid-turn.
  assert.match(await requestRedeploy('jarvis'), /now/);
  await new Promise((r) => realTimeout(r, 4300));
  assert.strictEqual(exited, RESTART_CODE, 'his tap never waits');
  exited = null; delete settings.redeploy_pending;
  // A stuck turn doesn't hold an automatic one either.
  isStuck = true;
  assert.match(await requestRedeploy('autofix'), /now/);
  isStuck = false;
  await new Promise((r) => realTimeout(r, 4300));
  exited = null; delete settings.redeploy_pending;
  // An automatic one waits while he's making progress.
  const text = await requestRedeploy('feature');
  assert.match(text, /as soon as J\.A\.R\.V\.I\.S\. finishes the turn he's on \("merge the worker branches"\)/);
  await new Promise((r) => realTimeout(r, 100));
  assert.strictEqual(settings.redeploy_pending, undefined, 'nothing marked while he is mid-turn');
  assert.strictEqual(exited, null, 'no restart while he is mid-turn');
  busy = false;
  await new Promise((r) => realTimeout(r, 4300));
  assert.strictEqual(JSON.parse(settings.redeploy_pending).by, 'feature');
  assert.strictEqual(exited, RESTART_CODE, 'restarts once his turn ended');
  console.log('front desk: all checks passed');
  realExit(0);
})().catch((e) => { console.error(e); realExit(1); });
