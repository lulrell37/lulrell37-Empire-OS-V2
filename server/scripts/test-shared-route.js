// The app's copy of Telegram's switches / news / drill / follow-through (routes/shared.js).
const assert = require('assert');
const sh = require('../routes/shared');
(async () => {
  let ran = null;
  const runtime = {
    newsBlock: async () => "[W.I.R.E.'S LATEST BRIEF — 10 min ago]",
    findTags: require('../personaRuntime').findTags,
    runInjections: async (body, persona, o) => { ran = { body, persona, asked: o.asked, depth: o.depth }; return 'SWITCH_OFF: ✓ OFF — stock picks'; },
  };
  sh._setDeps({ runtime, ft: require('../followThrough') });
  // Only A.R.A. and J.A.R.V.I.S. get the switches; everyone else is told to pass it on.
  const ara = await sh.context('ara');
  assert.match(ara, /\[SWITCH_OFF/); assert.match(ara, /\[TRADING_OFF\]/); assert.match(ara, /W\.I\.R\.E\.'S LATEST BRIEF/); assert.match(ara, /BREAKING_NOW/); assert.match(ara, /FOLLOW-THROUGH/);
  const atlas = await sh.context('atlas');
  assert.doesNotMatch(atlas, /\[SWITCH_OFF:/); assert.match(atlas, /only A\.R\.A\. and J\.A\.R\.V\.I\.S\./);
  assert.match(await sh.context('stephanie'), /QUIZ/);
  // Shared tags run on the server with his words; other tags are left to the app.
  assert.deepStrictEqual(await sh.tags('ara', 'Sure. [ADD_TASK: x]', 'add a task'), []);
  const out = await sh.tags('ara', 'Done. [SWITCH_OFF: stock picks] [ADD_TASK: x]', 'stop the stock picks');
  assert.match(out[0], /✓ OFF/);
  assert.strictEqual(ran.body, '[SWITCH_OFF: stock picks]'); assert.strictEqual(ran.asked, 'stop the stock picks'); assert.strictEqual(ran.depth, 0);
  // Follow-through notes.
  assert.match(sh.follow('ara', 'Let me check the calendar.', 'when is it').check, /you come back with it/);
  assert.match(sh.follow('selene', 'Can you send me the logo file?', 'make a flyer').ask, /only hears about what only he can give/);
  assert.deepStrictEqual(sh.follow('ara', 'The party is at 7 PM.', 'when'), { check: '', ask: '', scheduled: false });
  console.log('shared route: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
