// node server/scripts/test-group-chat.js — the Empire group chat: who posts a
// hand-off, and the fallback through A.R.A.'s bot (no network).
const assert = require('assert');
const sent = [];
const bot = (id, ok = true) => ({ isConfigured: () => ok, sendMessage: async (chat, text) => { sent.push({ id, chat, text }); } });
const telegram = require('../telegram');
const bots = { ara: bot('ara'), selene: bot('selene') };
telegram.botFor = (id) => bots[id] || null;
const store = require('../syncStore');
let saved = '';
store.getSetting = async () => saved;
store.setSetting = async (k, v) => { saved = v; };
const G = require('../groupChat');

(async () => {
  assert.ok(G.isGroupChat({ type: 'supergroup' }) && G.isGroupChat({ type: 'group' }) && !G.isGroupChat({ type: 'private' }));
  assert.strictEqual(await G.post('selene', 'hi'), false, 'no group set: nothing posted');
  assert.strictEqual(await G.setGroup({ id: -100123, title: 'Empire' }), true);
  assert.strictEqual(await G.setGroup({ id: -100123, title: 'Empire' }), false, 'same group: no second welcome');
  await G.relayAsked('ara', 'selene', 'make a cover');
  await G.relayAnswered('selene', 'Here it is.\n\n(S.E.L.E.N.E. ran no actions — if they said something was saved or created, it wasn\'t.)');
  await G.relayAnswered('scribe', 'Script done.');
  assert.deepStrictEqual(sent, [
    { id: 'ara', chat: '-100123', text: '→ S.E.L.E.N.E.: make a cover' },
    { id: 'selene', chat: '-100123', text: 'Here it is.' },
    { id: 'ara', chat: '-100123', text: 'S.C.R.I.B.E.:\nScript done.' },
  ]);
  assert.ok(/everyone/.test(G.GROUP_FRAME) && /one at a time/.test(G.GROUP_FRAME));
  console.log('group chat: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
