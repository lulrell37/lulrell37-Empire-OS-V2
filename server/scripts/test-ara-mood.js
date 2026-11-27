// node server/scripts/test-ara-mood.js — A.R.A.'s mood lingers and fades (server/araMood.js).
const assert = require('assert');
const mood = require('../araMood');
const store = {};
let now = Date.parse('2026-11-27T19:00:00Z');
mood._setDeps({ getSetting: async (k, dflt) => store[k] ?? dflt, setSetting: async (k, v) => { store[k] = v; }, now: () => now });
const min = 60000;
(async () => {
  assert.strictEqual(await mood.current(), null);
  assert(/YOUR MOOD: steady/.test(await mood.moodLine()));

  // Stephanie comes to her: angry 7.
  await mood.bump('angry', 7, 'he ignored his drill three times');
  let m = await mood.current();
  assert.strictEqual(m.mood, 'angry'); assert.strictEqual(m.level, 7);
  assert(/angry, strongly \(7\/10/.test(await mood.moodLine()) && /don't snap back to sweet/.test(await mood.moodLine()));
  // It fades gradually: half after 90 min, then a little, then gone.
  now += 90 * min; m = await mood.current(); assert.strictEqual(m.level, 3.5);
  assert(/a little, fading/.test(mood.lineFor(m)));
  now += 90 * min; assert.strictEqual((await mood.current()).level, 1.8);
  now += 90 * min; assert.strictEqual(await mood.current(), null, 'about 4.5 hours later she is herself again');

  // Same mood again stacks; a weaker one doesn't replace a stronger one.
  await mood.bump('angry', 5, 'x'); await mood.bump('angry', 5, 'again');
  assert((await mood.current()).level >= 7);
  await mood.bump('happy', 3, 'small win');
  assert.strictEqual((await mood.current()).mood, 'angry');

  // She sets it herself: he apologized.
  assert(/you're angry \(2\/10\)/.test(await mood.moodTag('angry | 2 | he apologized')));
  assert(/back to steady/.test(await mood.moodTag('neutral')));
  assert.strictEqual(await mood.current(), null);
  // Good moods pass sooner than anger.
  await mood.set('excited', 6, 'big win'); now += 45 * min;
  assert.strictEqual((await mood.current()).level, 3);
  console.log('ara mood ok');
})().catch((e) => { console.error(e); process.exit(1); });
