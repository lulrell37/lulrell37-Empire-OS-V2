// node server/scripts/test-reply-context.js — Telegram "reply to message": the
// persona is told which message he means (text, caption, a voice note matched by
// time in its history, his highlighted quote), in a private chat or the group.
const Module = require('module');
const assert = require('assert');
const load = Module._load;
let rows = [];
Module._load = function (req, parent, ...rest) {
  if (req === '../db') return { query: async (q, v) => { assert.match(q, /tg_messages/); return { rows: rows.filter((x) => x.role === v[1]) }; } };
  for (const m of ['../personaRuntime', '../personaTools', '../llm', '../personaVoice', '../vision', '../telegramMedia']) if (req === m) return {};
  return load.call(this, req, parent, ...rest);
};
const { repliedTo } = require('../routes/telegram');
const date = Math.floor(Date.UTC(2026, 10, 22, 19, 5) / 1000); // 2:05 PM ET
(async () => {
  assert.strictEqual(await repliedTo({ text: 'hi' }, 'ara'), null, 'no reply → nothing added');
  let c = await repliedTo({ chat: { type: 'private' }, text: 'is that still on?', reply_to_message: { from: { is_bot: true }, date, text: 'Your dentist moved to 4:30 Thursday.' } }, 'ara');
  assert.match(c, /REPLYING TO YOUR MESSAGE from Sun.*2:05 PM ET/);
  assert.match(c, /dentist moved to 4:30 Thursday/);
  assert.match(c, /about THAT message/);
  // a voice note from her: matched in her saved history by time
  rows = [{ role: 'assistant', content: 'Gold is up $14 since the open.' }];
  c = await repliedTo({ chat: { type: 'private' }, reply_to_message: { from: { is_bot: true }, date, voice: {} } }, 'ara');
  assert.match(c, /a voice note; its text: Gold is up \$14/);
  // his own message, with a highlighted part
  c = await repliedTo({ chat: { type: 'private' }, quote: { text: 'the Friday one' }, reply_to_message: { from: { is_bot: false }, date, text: 'move the Friday one and the Monday one' } }, 'ara');
  assert.match(c, /HIS OWN EARLIER MESSAGE/);
  assert.match(c, /highlighted: "the Friday one"/);
  // in the group: another persona's bot
  c = await repliedTo({ chat: { type: 'supergroup' }, reply_to_message: { from: { is_bot: true, first_name: 'T.A.L.O.N.' }, date, text: 'Long gold at 2650.' } }, 'ara');
  assert.match(c, /T\.A\.L\.O\.N\.'S MESSAGE/);
  console.log('reply context: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
