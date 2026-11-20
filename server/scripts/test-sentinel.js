// node server/scripts/test-sentinel.js — the sentinel alerts once on a break,
// stays quiet while it's known, and says when it clears. All services stubbed.
const Module = require('module');
const assert = require('assert');
const path = require('path');
const sent = [], pushes = [];
const settings = {};
let ellStatus = 200, ellBody = { character_count: 100, character_limit: 1000 };
let credit = {}, google = { linked: true, ok: true };
const stubs = {
  './syncStore': { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } },
  './telegram': { notifyOwner: async (t) => sent.push(t), configuredBots: () => [{ personaId: 'ara', getWebhookInfo: async () => ({ url: 'https://x', last_error_date: 0 }) }] },
  './pushSender': { pushAlert: async (k, title) => pushes.push(title) },
  './llm': { creditStatus: () => credit, subscriptionStatus: () => ({ enabled: false }) },
  './google': { googleStatus: async () => google },
  './redeploy': { codeInfo: () => ({ fell_back: false }) },
  './db': { query: async () => ({ rows: [{ n: 1 }] }) },
};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith('sentinel.js') && stubs[req]) return stubs[req];
  return load.call(this, req, parent, ...rest);
};
global.fetch = async () => ({ ok: ellStatus < 400, status: ellStatus, text: async () => JSON.stringify(ellBody) });
process.env.ELEVENLABS_API_KEY = 'k';
const serverLog = require(path.join(__dirname, '..', 'serverLog'));
const realErr = console.error; console.error = () => {};
serverLog.install();
const sentinel = require(path.join(__dirname, '..', 'sentinel'));

(async () => {
  // all fine -> nothing sent
  await sentinel.tick();
  assert.strictEqual(sent.length, 0, 'quiet when healthy');

  // ElevenLabs runs out -> one alert, push too
  ellBody = { character_count: 1000, character_limit: 1000 };
  await sentinel.tick();
  assert.strictEqual(sent.length, 1); assert.match(sent[0], /ElevenLabs.*out of characters/);
  assert.strictEqual(pushes.length, 1);
  await sentinel.tick();
  assert.strictEqual(sent.length, 1, 'no repeat while still broken');
  assert.strictEqual((await sentinel.status())[0].key, 'elevenlabs');

  // topped up -> cleared
  ellBody = { character_count: 10, character_limit: 1000 };
  await sentinel.tick();
  assert.match(sent[1], /ElevenLabs.*working again/);
  assert.strictEqual((await sentinel.status()).length, 0);

  // low balance -> warn
  ellBody = { character_count: 950, character_limit: 1000 };
  await sentinel.tick();
  assert.match(sent[2], /credits low/);
  ellBody = { character_count: 10, character_limit: 1000 };
  await sentinel.tick(); sent.length = 0;

  // credits, google
  credit = { xai: { outOfCreditUntil: Date.now() + 1e6 } };
  google = { linked: true, ok: false, error: 'invalid_grant' };
  await sentinel.tick();
  assert(sent.some((t) => /xAI.*out of credits/.test(t)));
  assert(sent.some((t) => /Google.*invalid_grant/.test(t)));
  credit = {}; google = { linked: true, ok: true }; sent.length = 0;
  await sentinel.tick();
  assert.strictEqual(sent.filter((t) => /working again/.test(t)).length, 2);

  // a loop failing twice -> alert; once -> nothing
  sent.length = 0;
  console.error('news wire cron failed: boom');
  await sentinel.tick();
  assert.strictEqual(sent.length, 0, 'one failure is a blip');
  console.error('news wire cron failed: boom again');
  console.error('ara voice failed: elevenlabs 401');
  await sentinel.tick();
  assert(sent.some((t) => /news wire: failed 2×.*boom again/.test(t)), sent.join('\n'));
  assert(!sent.some((t) => /ara voice/.test(t)));

  // app's ElevenLabs calls refused through the proxy
  sent.length = 0;
  serverLog.recordAi({ provider: 'elevenlabs', ok: false, status: 401, detail: 'quota_exceeded', method: 'POST', path: 'v1/text-to-speech/x' });
  await sentinel.tick();
  assert(sent.some((t) => /ElevenLabs voice \(app\).*quota_exceeded/.test(t)));
  console.log('test-sentinel: all passed');
})().catch((e) => { realErr(e); process.exit(1); });
