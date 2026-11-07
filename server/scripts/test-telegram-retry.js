// Telegram blips: reads retried, sends retried only when Telegram says it
// didn't deliver (429). No network: fetch stubbed, waits shortened.
// node server/scripts/test-telegram-retry.js
const assert = require('assert');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_OWNER_ID = '1';
const realTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => realTimeout(fn, Math.min(ms, 5), ...a); // no real waiting
const bot = require('../telegram').botFor('ara');

const reply = (status, body) => ({ status, ok: status < 300, json: async () => body, arrayBuffer: async () => new TextEncoder().encode('OGG').buffer });
let script = [];
const calls = [];
global.fetch = async (url) => {
  const u = String(url);
  calls.push(u.includes('/file/bot') ? `file:${u.split('/bottest-token/')[1]}` : u.split('/bottest-token/')[1]);
  const next = script.shift();
  if (next instanceof Error) throw next;
  return next;
};

(async () => {
  // The bug he hit: getFile 504 once, then fine — the voice note comes through.
  script = [reply(504, { ok: false, description: 'Gateway Timeout' }), reply(200, { ok: true, result: { file_path: 'voice/1.oga' } }), reply(200)];
  calls.length = 0;
  const buf = await bot.downloadFile('abc');
  assert.strictEqual(Buffer.from(buf).toString(), 'OGG');
  assert.deepStrictEqual(calls, ['getFile', 'getFile', 'file:voice/1.oga']);

  // A network timeout and a 502 on the download itself are retried too.
  script = [reply(200, { ok: true, result: { file_path: 'v.oga' } }), Object.assign(new Error('t'), { name: 'TimeoutError' }), reply(502), reply(200)];
  calls.length = 0;
  await bot.downloadFile('abc');
  assert.strictEqual(calls.length, 4);

  // Three failures in a row: gives up with the real reason.
  script = [504, 504, 504].map((s) => reply(s, { ok: false, description: 'Gateway Timeout' }));
  await assert.rejects(bot.downloadFile('abc'), /telegram getFile: Gateway Timeout/);

  // A real refusal (bad file id) isn't retried.
  script = [reply(400, { ok: false, description: 'Bad Request: invalid file_id' })];
  calls.length = 0;
  await assert.rejects(bot.downloadFile('x'), /invalid file_id/);
  assert.strictEqual(calls.length, 1);

  // Sends: a 504 is NOT retried (it may have been delivered — no double message)...
  script = [reply(504, { ok: false, description: 'Gateway Timeout' })];
  calls.length = 0;
  await assert.rejects(bot.tg('sendMessage', { chat_id: 1, text: 'hi' }), /Gateway Timeout/);
  assert.strictEqual(calls.length, 1);
  // ...but a 429 (not delivered) is.
  script = [reply(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }), reply(200, { ok: true, result: { message_id: 9 } })];
  calls.length = 0;
  assert.deepStrictEqual(await bot.tg('sendMessage', { chat_id: 1, text: 'hi' }), { message_id: 9 });
  assert.strictEqual(calls.length, 2);

  console.log('telegram retry: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
