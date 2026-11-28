// The word, verse and fact of the day have one copy: the server's hud_state singleton
// (owner, 2026-11-28). Covers the server endpoint helpers, the sync-push guard and the
// app's rules (no generating or nulling with a backend linked). node server/scripts/test-daily-hud-match.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// In-memory stand-in for ./db so no database is needed.
const store = new Map();
const fakeDb = {
  query: async (sql, params) => {
    if (/SELECT data FROM sync_rows/.test(sql)) { const v = store.get(params[0] + '|' + params[1]); return { rows: v ? [{ data: v }] : [] }; }
    if (/INSERT INTO sync_rows/.test(sql)) { store.set(params[0] + '|' + params[1], typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2]); return { rows: [] }; }
    return { rows: [] };
  },
};
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './db' && parent && /dailyBriefing\.js$/.test(parent.filename)) return fakeDb;
  return origLoad.call(this, req, parent, ...rest);
};
process.env.DAILY_BRIEFING = 'off'; // no AI call in the test
const daily = require('../dailyBriefing');
Module._load = origLoad;

(async () => {
  const server = { word_of_day: 'Cogent', word_phonetic: '/k/', word_def: 'clear', verse_of_day: 'Be strong', verse_ref: 'JOSHUA 1:9', fact_of_day: 'A fact' };
  store.set('hud_state|singleton', { ...server, empire_score: 10 });

  // 1. the endpoint's reader returns the server's values
  const r = await daily.readDaily();
  assert.strictEqual(r.word_of_day, 'Cogent'); assert.strictEqual(r.verse_ref, 'JOSHUA 1:9'); assert.strictEqual(r.fact_of_day, 'A fact');

  // 2. a phone's midnight reset (nulls) or stale/built-in values can't overwrite the server's
  const kept = daily.keepDaily({ empire_score: 0, word_of_day: null, verse_of_day: null, fact_of_day: null, word_def: '' }, store.get('hud_state|singleton'));
  assert.strictEqual(kept.word_of_day, 'Cogent'); assert.strictEqual(kept.fact_of_day, 'A fact'); assert.strictEqual(kept.empire_score, 0);
  const stale = daily.keepDaily({ word_of_day: 'Gudgeon', fact_of_day: 'built-in' }, store.get('hud_state|singleton'));
  assert.strictEqual(stale.word_of_day, 'Cogent'); assert.strictEqual(stale.fact_of_day, 'A fact');
  // no server copy yet: the phone's daily fields are dropped, other fields pass
  const first = daily.keepDaily({ empire_score: 5, word_of_day: 'Gudgeon' }, null);
  assert.strictEqual(first.word_of_day, undefined); assert.strictEqual(first.empire_score, 5);

  // 3. SET_WORD / SET_VERSE / SET_FACT through the server change the shared row, both sides read it
  await daily.setDaily({ word_of_day: 'Sedulous', word_phonetic: '/s/', word_def: 'diligent' });
  await daily.setDaily({ fact_of_day: 'New fact' });
  const after = await daily.readDaily();
  assert.strictEqual(after.word_of_day, 'Sedulous'); assert.strictEqual(after.fact_of_day, 'New fact'); assert.strictEqual(after.verse_ref, 'JOSHUA 1:9');
  assert.strictEqual(store.get('hud_state|singleton').empire_score, 10); // other fields untouched
  await daily.setDaily({ bogus: 'x', word_of_day: 5 }); // ignored
  assert.strictEqual((await daily.readDaily()).word_of_day, 'Sedulous');

  // 4. the routes and the app wiring are in place
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  assert.match(src('server/routes/shared.js'), /r\.get\('\/daily'/); assert.match(src('server/routes/shared.js'), /r\.post\('\/daily'/);
  assert.match(src('server/routes/sync.js'), /keepDaily/);
  const dbjs = src('src/services/database.js');
  assert.match(dbjs, /\$\{linked\?'':',word_of_day=NULL/, 'midnight rollover must not null the fields with a backend');
  assert.match(dbjs, /if\(await backendLinked\(\)\)\{try\{await applyServerDaily/, 'built-in lists are offline-only');
  assert.match(src('src/services/dailyBriefing.js'), /applyServerDaily/);
  const ch = src('src/services/commandHandler.js');
  assert.strictEqual((ch.match(/setDailyOnServer\(u\)/g) || []).length, 3);
  console.log('daily hud match: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
