// node server/scripts/test-group-chat.js — the Empire group chat: who posts a
// hand-off, and the fallback through A.R.A.'s bot (no network).
const assert = require('assert');
const sent = [];
const voices = [];
const bot = (id, ok = true) => ({ isConfigured: () => ok, sendMessage: async (chat, text) => { sent.push({ id, chat, text }); }, sendVoice: async (chat, ogg) => { voices.push({ id, chat, ogg: ogg.toString() }); } });
process.env.GROUP_VOICE = 'off'; // the text checks below run without voice
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
  assert.strictEqual(voices.length, 0, 'GROUP_VOICE=off sends no voice');

  // Voice: stub voiceNote, record who/which voice.
  delete process.env.GROUP_VOICE;
  const PV = require('../personaVoice');
  const calls = [];
  PV.voiceNote = async (id, text, o) => { calls.push({ id, text, o }); return { ogg: Buffer.from(`ogg:${id}`) }; };
  require('../sentinel').status = async () => [];
  sent.length = 0;
  await G.relayAnswered('scribe', 'Script done. J.A.R.V.I.S. has it.');
  await G.relayAnswered('selene', 'Cover ready.');
  await G.voiceIdle();
  assert.deepStrictEqual(voices.map((v) => v.id), ['ara', 'selene'], 'voiced from the bot that posted the text');
  assert.strictEqual(calls[0].id, 'scribe', "bot-less persona is voiced as itself, not as ara");
  assert.strictEqual(calls[0].o.scripted, true, 'no Grok script pass for another persona');
  assert.strictEqual(calls[0].o.voiceId, G.DEFAULT_VOICE_ID, 'no voice id: the generic default');
  assert.strictEqual(calls[1].o.voiceId, undefined, 'own voice id is used as is');
  process.env.GROUP_DEFAULT_VOICE = 'custom123';
  assert.strictEqual(G.voiceFor('scribe'), 'custom123');
  assert.strictEqual(G.voiceFor('selene'), require('../personas').ROSTER.selene.voiceId);
  delete process.env.GROUP_DEFAULT_VOICE;
  // Long text is shortened but keeps numbers; the message stays whole.
  const long = `${'Gold is chopping sideways today and nothing is clean. '.repeat(30)}Target 4,215 on the break.`;
  const spoken = G.voiceText(long);
  assert.ok(spoken.length <= 640 && /4,215/.test(spoken), spoken.length);
  calls.length = 0; sent.length = 0;
  await G.relayAnswered('selene', long);
  await G.voiceIdle();
  assert.strictEqual(sent[0].text.length, long.length, 'full text still posted');
  assert.ok(calls[0].text.length <= 640);
  // A voice failure never blocks the text and is logged for the sentinel.
  PV.voiceNote = async () => { throw new Error('boom'); };
  const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' '));
  sent.length = 0;
  assert.strictEqual(await G.post('selene', 'still posts'), true);
  await G.voiceIdle();
  console.error = oe;
  assert.strictEqual(sent.length, 1);
  assert.ok(errs.some((e) => e.startsWith('group chat failed: voice')), errs.join('|'));
  // ElevenLabs out of credits: told to skip it.
  PV.voiceNote = async (id, t, o) => { calls.push(o); return { ogg: Buffer.from('x') }; };
  require('../sentinel').status = async () => [{ key: 'elevenlabs', msg: 'out of characters (1 of 1 used)' }];
  calls.length = 0;
  await G.post('selene', 'hi'); await G.voiceIdle();
  assert.strictEqual(calls[0].noEleven, true);
  assert.ok(/everyone/.test(G.GROUP_FRAME) && /one at a time/.test(G.GROUP_FRAME));
  const line = G.groupLine('ara', 'selene', 'make a cover', 'Here it is.', Date.parse('2026-11-21T14:03:00Z'));
  assert.ok(line.startsWith('[IN THE EMPIRE GROUP CHAT, Sat 9:03 AM ET — A.R.A. asked you') && line.includes('You answered: Here it is.'), line);
  // Drift: every voice id in the app roster is on the server roster (and equal); the server has none the app lacks.
  {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../../src/personas/personas.js'), 'utf8');
    const app = {};
    for (const m of src.matchAll(/\n  (\w+):\{id:'\w+',[^\n]*?elevenlabsVoiceId:(?:'([^']*)'|null)/g)) app[m[1]] = m[2] || null;
    assert.ok(Object.keys(app).length > 15 && app.rogue === 'bD9maNcCuQQS75DGuteM', 'app voice ids parsed');
    const R = require('../personas').ROSTER;
    const bad = [];
    for (const [id, v] of Object.entries(app)) {
      if (!R[id]) { if (v) bad.push(`${id}: in app with voice ${v} but not on the server roster`); continue; }
      if ((R[id].voiceId || null) !== v) bad.push(`${id}: app ${v} vs server ${R[id].voiceId || null}`);
    }
    for (const id of Object.keys(R)) if (R[id].voiceId && !(id in app)) bad.push(`${id}: server voice with no app persona`);
    assert.deepStrictEqual(bad, [], 'voice id drift between src/personas/personas.js and server/personas.js:\n' + bad.join('\n'));
    assert.strictEqual(G.voiceFor('rogue'), 'bD9maNcCuQQS75DGuteM', 'rogue uses her own voice in the group');
  }
  console.log('group chat: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
