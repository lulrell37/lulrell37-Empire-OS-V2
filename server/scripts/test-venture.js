// New-venture detection and the fixed order: S.A.G.E. -> A.T.L.A.S. (money) -> lane owners -> result.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { detectVenture } = require('../personas');
const V = require('../venture');

for (const t of ['I want to start a YouTube channel about cars', "I'm thinking about starting a clothing line", 'new business idea: junk removal', "let's launch a podcast", 'I decided to start new YouTube channels to make money', 'I want to start a newsletter'])
  assert.ok(detectVenture(t), 'should detect: ' + t);
for (const t of ['what is the gold price', 'start the timer', 'how is my business doing', 'I want to start my workout', '', 'launch the build'])
  assert.ok(!detectVenture(t), 'should not detect: ' + t);

assert.ok(V.makesMoney('numbers…\nMONEY: yes') && !V.makesMoney('x\nMONEY: no') && V.makesMoney('no line'));
const ids = V.laneOwners('I want to start a clothing brand', { money: true, asker: 'ara' }).map((l) => l.id);
assert.deepStrictEqual(ids.slice(0, 4), ['selene', 'scribe', 'aisha', 'scout']);
assert.ok(!V.laneOwners('start a channel', { money: false }).some((l) => l.id === 'scout'));
assert.ok(!ids.some((i) => ['ara', 'sage', 'atlas'].includes(i)));

(async () => {
  const calls = [];
  const relay = async (id, msg) => { calls.push({ id, msg }); return id === 'sage' ? 'Channels earn $2k/mo.\nMONEY: yes' : id + ' did it'; };
  let added = false;
  const r = await V.runVenture('I want to start a YouTube channel', { asker: 'ara', relay, businesses: async () => (calls.some((c) => c.id === 'atlas') ? (added = 'YT Channel') : null) });
  assert.strictEqual(calls[0].id, 'sage', 'S.A.G.E. first');
  assert.strictEqual(calls[1].id, 'atlas', 'A.T.L.A.S. second');
  assert.ok(/ADD_BUSINESS/.test(calls[1].msg) && /Channels earn/.test(calls[1].msg), 'atlas gets research + tag');
  assert.ok(calls.slice(2).map((c) => c.id).includes('selene') && calls.slice(2).every((c) => /Channels earn/.test(c.msg)), 'lane owners after, with research');
  assert.ok(r.money && r.added === 'YT Channel');
  const out = V.resultBlock(r, 'ara');
  assert.ok(/NEW VENTURE RESULT/.test(out) && /YT Channel/.test(out));

  // not money: no A.T.L.A.S.
  const calls2 = [];
  const r2 = await V.runVenture('I want to start a prayer journal project', { relay: async (id, m) => { calls2.push(id); return id === 'sage' ? 'free\nMONEY: no' : 'ok'; } });
  assert.ok(!calls2.includes('atlas') && !calls2.includes('scout') && !r2.money);

  // a failing step doesn't stop the rest
  const r3 = await V.runVenture('I want to start a store', { relay: async (id) => { if (id === 'atlas') throw new Error('boom'); return 'MONEY: yes'; }, businesses: async () => null });
  assert.ok(r3.steps.some((s) => s.id === 'atlas' && !s.ok) && r3.steps.some((s) => s.id === 'selene'));
  assert.ok(/did not get the business/.test(V.resultBlock(r3)));

  // wiring + sync
  const rt = fs.readFileSync(path.join(__dirname, '..', 'personaRuntime.js'), 'utf8');
  assert.ok(/ventureStep\(persona, userText/.test(rt) && /depth: 1/.test(rt) && /MAX_RELAY_DEPTH = 3/.test(rt));
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'personas', 'personas.js'), 'utf8');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'personas.js'), 'utf8');
  const norm = (s) => s.replace(/\s+/g, '');
  const grab = (src, a, b) => norm(src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a))));
  assert.strictEqual(grab(app, 'const VENTURE_INTENT', 'export function detectVenture').replace(/exportfunction/g, 'function'), grab(srv, 'const VENTURE_INTENT', 'function detectVenture'), 'venture regexes drifted');
  assert.ok(require('../ownerProfile').PINNED.some((l) => /New venture, fixed order/.test(l)), 'pinned');
  console.log('venture: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
