// node server/scripts/test-loud.js — nothing dies in silence: the last-resort
// message goes to A.R.A.'s bot, falls back to a phone push, never throws, and a
// repeat of the same thing within 30 min is dropped.
const Module = require('module');
const assert = require('assert');
const tgSent = [], pushes = [];
let tgDown = false;
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './telegram') return { OWNER_ID: 1, botFor: () => ({ isConfigured: () => true, sendMessage: async (c, t) => { if (tgDown) throw new Error('502'); tgSent.push(t); } }) };
  if (req === './pushSender') return { pushAlert: async (k, title, body) => pushes.push(body) };
  return load.call(this, req, parent, ...rest);
};
const { tellAra } = require('../loud');
(async () => {
  await tellAra('a', 'worker #3 finished but its report could not be sent');
  assert.match(tgSent[0], /^⚠️ worker #3/);
  await tellAra('a', 'same again');
  assert.strictEqual(tgSent.length, 1, 'repeat dropped');
  tgDown = true;
  await tellAra('b', 'Telegram is down too');
  assert.strictEqual(pushes.length, 1, 'phone push when Telegram fails');
  console.log('loud: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
