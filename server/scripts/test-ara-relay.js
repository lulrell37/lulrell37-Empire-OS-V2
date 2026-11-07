// A.R.A. catches him up on what another persona sent her; she doesn't read it out.
// No network: the writers are stubbed. node server/scripts/test-ara-relay.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const llm = require('../llm');
// personaVoice takes its copy of this when it loads, so the stub goes in first.
const araVoice = require('../araVoice');
let grokVoice = async () => null;
araVoice.synthesizeAraVoice = (...a) => grokVoice(...a);
const { relayFrom, relayHint, araScript } = require('../personaVoice');
const { ARA_SCRIPT, ARA_VOICE } = require('../araVoice');

(async () => {
  // The two copies of her script direction can't drift.
  const app = fs.readFileSync(path.join(__dirname, '../../src/services/voiceCues.js'), 'utf8');
  assert.ok(app.includes(ARA_SCRIPT), 'ARA_SCRIPT differs between server/araVoice.js and src/services/voiceCues.js');
  assert.match(ARA_SCRIPT, /never read their message out/);
  // One description of her voice, word for word, everywhere it appears.
  const TONE = /sultry, seductive, slightly flirty and a touch unhinged/i;
  const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
  for (const s of [ARA_VOICE, ARA_SCRIPT, read('src/services/realtimeVoice.js'), read('server/morningBrief.js')]) assert.match(s, TONE);
  // Her voice isn't described as soft (the direction, GO LIVE); [softly] is just a cue she can use.
  assert.doesNotMatch(`${ARA_VOICE}${ARA_SCRIPT.replace('[softly]', '')}`, /soft/i);
  // Not breathy: husky. Whispers is the last cue.
  assert.doesNotMatch(`${ARA_VOICE}${ARA_SCRIPT}${read('server/morningBrief.js')}`, /breathy/i);
  assert.match(ARA_SCRIPT, /\[husky\] \[teasing\] \[softly\] \[laughs\] \[giggles\] \[sighs\] \[excited\] \[whispers\]\. Use/);
  assert.match(ARA_VOICE, /low and husky/);
  // "Mmm" only when she's flirting, never as her opener.
  assert.match(ARA_SCRIPT, /"Mmm" is only for a genuinely flirty moment: never open with it/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../../src/services/realtimeVoice.js'), 'utf8'), /soft/i);

  // Alert openers that don't say "→ A.R.A." still count, but only for desk messages.
  assert.strictEqual(relayFrom('📈 Talon just opened a trade', true), 'Talon');
  assert.strictEqual(relayFrom('📰 Wire — breaking news, Mr. Burrus.', true), 'Wire');
  assert.strictEqual(relayFrom("🔒 Scalp paid — Talon's swing is safe", true), 'Talon');
  assert.strictEqual(relayFrom('📈 Talon just opened a trade'), null);
  assert.strictEqual(relayFrom("✅ Server's live on the new code, Mr. Burrus\nJarvis can file a fix", true), null);
  assert.strictEqual(relayFrom('the wire transfer cleared', true), null);
  assert.strictEqual(relayFrom('Talon → Ara: my gold call was wrong'), 'Talon');
  assert.match(relayHint('📈 Talon just opened a trade', true), /Don't read it out/);

  const real = llm.chatAs;
  const calls = [];
  try {
    // The relay reaches the writer with the retell instruction.
    llm.chatAs = async (api, model, sys, msgs) => { calls.push({ api, sys, user: msgs[0].content }); return '[warmly] Talon just pinged me...'; };
    assert.strictEqual(await araScript('Talon → Ara: my gold call was wrong.', ''), '[warmly] Talon just pinged me...');
    assert.match(calls[0].user, /Don't read it out/);

    // Grok down: Claude writes it instead of her reading the raw text.
    calls.length = 0;
    llm.chatAs = async (api) => { calls.push(api); if (api === 'xai') throw new Error('no credit'); return 'Talon says the call was wrong.'; };
    assert.strictEqual(await araScript('Talon → Ara: my gold call was wrong.', ''), 'Talon says the call was wrong.');
    assert.deepStrictEqual(calls, ['xai', 'anthropic']);

    // Both down: attributed and cut short, never the whole thing as hers.
    llm.chatAs = async () => { throw new Error('down'); };
    const long = `Talon → Ara: my gold call was wrong. ${'I moved my stop. '.repeat(60)}`;
    const said = await araScript(long, '');
    assert.ok(said.startsWith('Message from Talon, Mr. Burrus. my gold call was wrong.'), said);
    assert.ok(said.length < 500 && said.endsWith('The rest is in the message.'), said);

    // A long message: the writer is told to give a very detailed summary, with room for it.
    const report = `Talon → Ara: here is my full read. ${'Gold held 2,410 and I moved my stop to 2,395. '.repeat(40)}`;
    let seen;
    llm.chatAs = async (api, model, sys, msgs, opts) => { seen = { user: msgs[0].content, opts }; return 'Talon walked me through it...'; };
    await araScript(report, '');
    assert.match(seen.user, /very detailed summary/);
    assert.match(seen.user, /long message, about \d+ words/);
    assert.strictEqual(seen.opts.maxTokens, 2200);
    await araScript('Talon → Ara: gold hit target.', '');
    assert.doesNotMatch(seen.user, /very detailed summary|long message/);
    assert.match(seen.user, /far shorter than this/);
    assert.strictEqual(seen.opts.maxTokens, 1200);
    // Both writers down on a long one: the start plus the lines with numbers.
    llm.chatAs = async () => { throw new Error('down'); };
    const fb = await araScript(`Talon → Ara: quick note first, nothing major here at all, just context on where things stand today. ${'Nothing new to add on the overnight session so far. '.repeat(10)}\nGold stop moved to 2,395.\nBitcoin target 71,500.`, '');
    assert.match(fb, /The key points: .*2,395.*71,500/);

    // Her own reply: one writer, and voiced as written if it fails.
    calls.length = 0;
    llm.chatAs = async (api) => { calls.push(api); throw new Error('down'); };
    assert.strictEqual(await araScript('Your 3pm moved to 4.', ''), 'Your 3pm moved to 4.');
    assert.deepStrictEqual(calls, ['xai']);
  } finally { llm.chatAs = real; }

  // ElevenLabs down: she falls to her own Grok voice; other personas don't.
  {
    const { voiceNote } = require('../personaVoice');
    const store = require('../syncStore');
    const realSetting = store.getSetting, realFetch = global.fetch, realEl = process.env.ELEVENLABS_API_KEY, realAi = process.env.OPENAI_API_KEY;
    const grokCalls = [];
    try {
      store.getSetting = async (k, d) => d;
      llm.chatAs = async () => 'Your 3pm moved to 4.';
      process.env.ELEVENLABS_API_KEY = 'test';
      delete process.env.OPENAI_API_KEY;
      global.fetch = async () => { throw new Error('elevenlabs down'); };
      grokVoice = async (t) => { grokCalls.push(t); return Buffer.from('grok'); };
      const ara = await voiceNote('ara', 'Your 3pm moved to 4.');
      assert.strictEqual(String(ara.ogg), 'grok');
      assert.strictEqual(ara.fallback, true);
      assert.deepStrictEqual(grokCalls, ['Your 3pm moved to 4.']);
      grokCalls.length = 0;
      const atlas = await voiceNote('atlas', 'Hello.');
      assert.strictEqual(atlas.ogg, null);
      assert.strictEqual(grokCalls.length, 0, 'only A.R.A. has the Grok backup');
      // Grok down too: on to the last resort, not a crash.
      grokVoice = async () => { throw new Error('grok down'); };
      assert.strictEqual((await voiceNote('ara', 'Your 3pm moved to 4.')).ogg, null);
    } finally {
      store.getSetting = realSetting; llm.chatAs = real; global.fetch = realFetch;
      if (realEl === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = realEl;
      if (realAi !== undefined) process.env.OPENAI_API_KEY = realAi;
    }
  }

  // A long script is voiced in pieces and joined — never cut off at 4000 characters.
  {
    const { voiceNote } = require('../personaVoice');
    const store = require('../syncStore');
    const realSetting = store.getSetting, realFetch = global.fetch, realEl = process.env.ELEVENLABS_API_KEY;
    const sent = [];
    try {
      store.getSetting = async (k, d) => d;
      process.env.ELEVENLABS_API_KEY = 'test';
      const script = 'This is one sentence of her summary. '.repeat(300); // ~11k chars
      llm.chatAs = async () => script;
      global.fetch = async (url, o) => { sent.push(JSON.parse(o.body).text); return { ok: false, status: 500, text: async () => 'stop here' }; };
      await voiceNote('ara', `Talon → Ara: ${'x '.repeat(800)}`, { relay: true });
      assert.ok(sent.length >= 1 && sent.every((t) => t.length <= 3800), 'pieces fit the TTS limit');
    } finally {
      store.getSetting = realSetting; llm.chatAs = real; global.fetch = realFetch;
      if (realEl === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = realEl;
    }
    const { ttsChunks } = require('../personaVoice');
    const pieces = ttsChunks('This is one sentence of her summary. '.repeat(300));
    assert.ok(pieces.length === 3 && pieces.every((p) => p.length <= 3800 && p.endsWith('.')), 'split on sentence ends');
    assert.strictEqual(pieces.join(' '), 'This is one sentence of her summary. '.repeat(300).trim());
  }

  console.log('ara relay: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
