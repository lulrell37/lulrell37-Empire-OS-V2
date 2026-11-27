// node server/scripts/test-steel-session.js — Steel sessions are opened long enough to
// wait out an emailed sign-in link, and released after (2026-11-27, worker 92).
const assert = require('assert');
const ba = require('../browserAgent');
(async () => {
  const calls = [];
  let allow = 45;
  global.fetch = async (url, o) => {
    calls.push({ url, body: o.body ? JSON.parse(o.body) : null, headers: o.headers });
    if (/\/release$/.test(url)) return { ok: true, json: async () => ({}) };
    const min = JSON.parse(o.body).timeout / 60000;
    return min <= allow ? { ok: true, json: async () => ({ id: `sess-${min}` }) } : { ok: false, status: 400, json: async () => ({ error: 'timeout over plan limit' }) };
  };
  let s = await ba.steelSession('wss://connect.steel.dev?apiKey=KEY&projectId=P1');
  assert.deepStrictEqual(s, { id: 'sess-45', key: 'KEY' });
  assert.strictEqual(calls[0].body.timeout, 45 * 60000, '45 minutes, not the 5-minute default');
  assert.strictEqual(calls[0].headers['steel-api-key'], 'KEY');
  assert.strictEqual(calls[0].body.projectId, 'P1');
  // A plan that allows less: 15 minutes.
  allow = 15; calls.length = 0;
  s = await ba.steelSession('wss://connect.steel.dev?apiKey=KEY');
  assert.strictEqual(s.id, 'sess-15'); assert.strictEqual(calls.length, 2);
  // Neither: it says why (launch then falls back to the plain connect URL).
  allow = 1;
  await assert.rejects(() => ba.steelSession('wss://connect.steel.dev?apiKey=KEY'), /400/);
  await ba.steelRelease({ id: 'sess-45', key: 'KEY' });
  assert(/sessions\/sess-45\/release$/.test(calls[calls.length - 1].url));
  console.log('steel session ok');
})().catch((e) => { console.error(e); process.exit(1); });
