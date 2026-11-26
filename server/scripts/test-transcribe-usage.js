// node server/scripts/test-transcribe-usage.js — Groq-first transcription, its OpenAI fallbacks, and the usage log.
const assert = require('assert');
// syncStore needs a database; stand in for it (the real getSetting/setSetting are what production uses).
const ssPath = require.resolve('../syncStore');
const ss = { getSetting: async (_k, f) => f, setSetting: async () => {} };
require.cache[ssPath] = { id: ssPath, filename: ssPath, loaded: true, exports: ss };
const usage = require('../transcribeUsage');
const llm = require('../llm');

// In-memory store for app_settings.transcribe_usage.
let saved = '{}';
usage.setStore({ get: async () => saved, set: async (_k, v) => { saved = v; } });

const realFetch = global.fetch;
let calls = [];
let groqReply; // () => Response | throws
const wav = (n) => Buffer.alloc(n, 1);
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers });
global.fetch = async (url, opts = {}) => {
  const isGroq = String(url).includes('groq.com');
  const body = opts.body;
  calls.push({ provider: isGroq ? 'groq' : 'openai', model: body.get('model'), fmt: body.get('response_format'), gran: body.getAll('timestamp_granularities[]'), temp: body.get('temperature'), prompt: body.get('prompt'), lang: body.get('language') });
  if (isGroq) return groqReply();
  return json({ text: 'from openai', duration: 30, segments: [{ start: 0, end: 30, text: 'from openai' }], words: [{ word: 'hi', start: 0.1, end: 0.3 }] });
};
const okGroq = () => json({ text: 'from groq', duration: 12.5, segments: [{ start: 0, end: 12.5, text: 'from groq', avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01 }], words: [{ word: 'from', start: 0, end: 0.4 }] });

(async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  const flush = () => usage.record({ provider: 'openai', job: 'other', sec: 0 }).then(() => { const d = JSON.parse(saved); d.entries.pop(); saved = JSON.stringify(d); });
  const entries = async () => { await flush(); return JSON.parse(saved).entries; };
  const reset = async () => { await flush(); calls = []; saved = '{}'; llm._resetGroqPause(); };

  // 1. Groq happy path: same parameters, nothing falls back, usage logged.
  await reset(); process.env.GROQ_API_KEY = 'gsk-test'; groqReply = okGroq;
  const words = await llm.transcribeWords(wav(5000), 'c.mp3', { prompt: 'context here', job: 'clip captions' });
  assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].provider, 'groq');
  assert.strictEqual(calls[0].model, 'whisper-large-v3-turbo'); assert.strictEqual(calls[0].fmt, 'verbose_json');
  assert.deepStrictEqual(calls[0].gran, ['word', 'segment']); assert.strictEqual(calls[0].temp, '0'); assert.strictEqual(calls[0].prompt, 'context here');
  assert.strictEqual(words.length, 1);
  let e = await entries();
  assert.strictEqual(e.length, 1); assert.strictEqual(e[0].provider, 'groq'); assert.strictEqual(e[0].fallback, false); assert.strictEqual(e[0].job, 'clip captions'); assert.strictEqual(e[0].sec, 12.5); assert.strictEqual(e[0].bytes, 5000);
  // segment fields flow through for the invented-word filter
  const r = await llm.stt(wav(5000), 'c.mp3', [], { job: 'x' });
  assert.strictEqual(r.data.segments[0].no_speech_prob, 0.01); assert.strictEqual(r.data.segments[0].avg_logprob, -0.2); assert.strictEqual(r.data.segments[0].compression_ratio, 1.1);
  assert.strictEqual(e[0].job, 'clip captions'); // unknown job names are 'other'
  assert.strictEqual(usage.normJob('x'), 'other');

  // 2. Fallback triggers: 429, 500, timeout, other refusal, no words, no key, over 25 MB.
  const cases = [
    ['429', () => json({ error: 'rate' }, 429, { 'retry-after': '30' }), 'Groq 429'],
    ['500', () => json({ error: 'boom' }, 500), 'Groq 500'],
    ['503', () => json({ error: 'down' }, 503), 'Groq 503'],
    ['timeout', () => { const x = new Error('The operation was aborted due to timeout'); x.name = 'TimeoutError'; throw x; }, 'Groq timeout'],
    ['401', () => json({ error: 'bad key' }, 401), 'Groq 401'],
    ['network', () => { throw new Error('ECONNRESET'); }, 'Groq error'],
    ['no words', () => json({ text: 'spoken but no words', duration: 5, segments: [], words: [] }), 'Groq returned no word timestamps'],
  ];
  for (const [name, reply, why] of cases) {
    await reset(); groqReply = reply;
    const w = await llm.transcribeWords(wav(5000), 'c.mp3', { job: 'raw edit' });
    assert.deepStrictEqual(calls.map((c) => c.provider), ['groq', 'openai'], name);
    assert.strictEqual(calls[1].model, 'whisper-1'); assert.deepStrictEqual(calls[1].gran, ['word', 'segment']);
    assert.strictEqual(w.length, 1, name);
    e = await entries();
    assert.strictEqual(e[0].provider, 'openai', name); assert.strictEqual(e[0].fallback, true, name); assert.ok(e[0].why.startsWith(why), `${name}: ${e[0].why}`); assert.strictEqual(e[0].job, 'raw edit');
  }
  // empty speech with no words is legitimate: no pointless fallback
  await reset(); groqReply = () => json({ text: '', duration: 3, segments: [], words: [] });
  assert.deepStrictEqual(await llm.transcribeWords(wav(5000), 'c.mp3'), []); assert.strictEqual(calls.length, 1);
  // segments don't need words
  await reset(); groqReply = () => json({ text: 'hi', duration: 3, segments: [{ start: 0, end: 3, text: 'hi' }] });
  assert.strictEqual((await llm.transcribeSegments(wav(5000), 'a.mp3', { prompt: '', job: 'clip scan' })).length, 1); assert.strictEqual(calls.length, 1);
  // after a 429, Groq is skipped until the pause ends
  await reset(); groqReply = () => json({}, 429, { 'retry-after': '30' });
  await llm.transcribeSegments(wav(5000), 'a.mp3', { prompt: '' }); await llm.transcribeSegments(wav(5000), 'a.mp3', { prompt: '' });
  assert.deepStrictEqual(calls.map((c) => c.provider), ['groq', 'openai', 'openai']);
  e = await entries(); assert.ok(/paused/.test(e[1].why));
  // no key
  await reset(); delete process.env.GROQ_API_KEY; groqReply = okGroq;
  assert.strictEqual(await llm.transcribe(wav(5000), 'v.ogg'), 'from openai'); assert.deepStrictEqual(calls.map((c) => c.provider), ['openai']);
  e = await entries(); assert.strictEqual(e[0].why, 'no Groq key'); assert.strictEqual(e[0].job, 'voice note');
  // key from app_settings.groq_api_key
  await reset();
  const realGet = ss.getSetting; ss.getSetting = async (k, f) => (k === 'groq_api_key' ? 'gsk-from-settings' : f);
  assert.strictEqual(await llm.transcribe(wav(5000), 'v.ogg'), 'from groq'); assert.strictEqual(calls[0].provider, 'groq');
  ss.getSetting = realGet;
  // over 25 MB goes straight to OpenAI
  await reset(); process.env.GROQ_API_KEY = 'gsk-test';
  await llm.transcribeSegments(wav(llm.GROQ_MAX_BYTES + 1), 'big.mp3', { prompt: '' });
  assert.deepStrictEqual(calls.map((c) => c.provider), ['openai']); e = await entries(); assert.strictEqual(e[0].why, 'over Groq 25 MB limit');
  // too-short stubs make no call and no log
  await reset(); assert.deepStrictEqual(await llm.transcribeWords(wav(100)), []); assert.strictEqual(calls.length, 0);
  // Groq down and no OpenAI key: a clear error
  await reset(); delete process.env.OPENAI_API_KEY; groqReply = () => json({}, 500);
  await assert.rejects(llm.transcribeSegments(wav(5000), 'a.mp3', { prompt: '' }), /OPENAI_API_KEY.*Groq 500/);
  process.env.OPENAI_API_KEY = 'sk-test';
  // OpenAI failing too throws
  await reset(); groqReply = () => json({}, 500);
  const f2 = global.fetch; global.fetch = async (u, o) => (String(u).includes('groq') ? json({}, 500) : json({ error: 'nope' }, 500));
  await assert.rejects(llm.transcribeSegments(wav(5000), 'a.mp3', { prompt: '' }), /whisper 500/); global.fetch = f2;

  // 3. Usage roll-up. Fixed clock: 2026-11-24 noon ET.
  const NOW = Date.parse('2026-11-24T17:00:00Z'); const D = 86400000;
  saved = '{}';
  const rec = (daysAgo, o) => usage.record({ bytes: 1000, ...o }, NOW - daysAgo * D);
  await rec(0, { provider: 'groq', job: 'clip scan', sec: 3600 });
  await rec(1, { provider: 'groq', job: 'auto clip', sec: 1800 });
  await rec(2, { provider: 'openai', fallback: true, why: 'Groq 429', job: 'clip scan', sec: 600 });
  await rec(12, { provider: 'openai', job: 'transcribe', sec: 1200 });   // this month, not last 7 days
  await rec(40, { provider: 'groq', job: 'raw edit', sec: 7200 });        // last month, still in the 90 days
  await rec(100, { provider: 'groq', job: 'voice note', sec: 360 });      // older than 90 days: rolls into a day total
  let data = usage.roll(JSON.parse(saved), NOW);
  assert.strictEqual(data.entries.length, 5, 'only the 90-day entries stay detailed');
  const oldDay = usage.etDay(NOW - 100 * D);
  assert.strictEqual(data.days[oldDay].n, 1); assert.strictEqual(data.days[oldDay].groqSec, 360); assert.strictEqual(data.days[oldDay].jobs['voice note'], 360);
  const mon = usage.summarize(data, (d) => d.slice(0, 7) === '2026-11');
  assert.strictEqual(mon.n, 4); assert.strictEqual(mon.groqSec, 5400); assert.strictEqual(mon.openaiSec, 1800); assert.strictEqual(mon.fallbacks, 1);
  assert.strictEqual(mon.jobs['clip scan'], 4200);
  const expectCost = (5400 / 3600) * 0.04 + (1800 / 60) * 0.006;
  assert.ok(Math.abs(mon.cost - expectCost) < 1e-9, `${mon.cost} vs ${expectCost}`);
  // rolled-up days count in a month total too
  const old = usage.summarize(data, (d) => d.slice(0, 7) === oldDay.slice(0, 7)); assert.strictEqual(old.groqSec, 360);
  const rep = usage.report(data, NOW);
  assert.ok(/This month \(2026-11\): 2\.00 audio hours in 4 calls/.test(rep), rep);
  assert.ok(/Last 7 days: 1\.67 audio hours in 3 calls/.test(rep), rep);
  assert.ok(/clip scan 1\.17 h/.test(rep) && /Groq 1\.50 h, OpenAI 0\.17 h; 1 fell back/.test(rep) && /Groq \$0\.04\/h/.test(rep) && /Groq 429 x1/.test(rep), rep);
  assert.ok(/no transcriptions logged/.test(usage.report({ entries: [], days: {} }, NOW)));
  // the tag is wired for the three personas
  const src = require('fs').readFileSync(require('path').join(__dirname, '../personaRuntime.js'), 'utf8');
  assert.ok(/'TRANSCRIBE_USAGE' && \['jarvis', 'ara', 'rogue'\]/.test(src.replace(/name === /, '')));
  assert.ok(usage.USAGE_TOOLS.includes('[TRANSCRIBE_USAGE]'));

  global.fetch = realFetch;
  console.log('transcribe usage: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
