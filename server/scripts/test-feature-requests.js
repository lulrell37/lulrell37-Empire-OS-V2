// node server/scripts/test-feature-requests.js — a persona missing a tool in its
// lane asks J.A.R.V.I.S. ([NEED_FEATURE]); a worker builds it; it merges and goes
// live on its own; after the restart the persona comes back to him with the
// answer. Trading/money/workflow PRs wait for his tap. All stubbed.
const Module = require('module');
const assert = require('assert');
const settings = {}, started = [], merged = [], redeploys = [], outOfBand = [], sent = [], cards = [];
let files = ['server/personaRuntime.js', 'server/scripts/test-weather.js'];
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  if (req === './workers') return { start: async (o) => { started.push(o); return { id: String(20 + started.length) }; } };
  if (req === './buildAgent') return { REPO: { owner: 'o', repo: 'r' }, gh: async (p, o = {}) => {
    if (/\/files/.test(p)) return files.map((filename) => ({ filename }));
    if (/\/merge$/.test(p)) { merged.push(p); return { merged: true }; }
    if (/\/pulls$/.test(p)) return { number: 77, html_url: 'https://github.com/o/r/pull/77' };
    throw new Error(p);
  } };
  if (req === './redeploy') return { requestRedeploy: async (by) => { redeploys.push(by); return 'restarting'; } };
  if (req === './routes/telegram') return { personaOutOfBand: async (id, text) => { outOfBand.push({ id, text }); return true; } };
  if (req === './telegram') return { OWNER_ID: 1, botFor: () => ({ isConfigured: () => true, sendMessage: async (c, t, o) => { sent.push(t); if (o && o.reply_markup) cards.push(t); } }) };
  if (req === './db') return { query: async () => ({ rows: [] }) };
  return load.call(this, req, parent, ...rest);
};
process.env.EMPIRE_SUPERVISED = '1';
const F = require('../featureRequests');

(async () => {
  // Only his own message files one.
  assert.match(await F.request('ara', 'live weather in my prompt', { asked: '' }), /not filed/);
  const r = await F.request('ara', 'live weather every turn | what is the weather tonight', { asked: "what's the weather tonight?" });
  assert.match(r, /worker #21 is building it/);
  assert.match(r, /ONE short line/, 'she only says one line now');
  assert.strictEqual(started[0].purpose, 'feature');
  assert.match(started[0].task, /A\.R\.A\./);
  assert.match(started[0].task, /AUTOMATICALLY/);
  // the same ask again isn't filed twice
  assert.match(await F.request('ara', 'live weather every turn please', { asked: 'weather?' }), /not filed again/);
  assert.strictEqual(started.length, 1);

  // The worker reports DONE with a pushed branch → merged, redeploy, no card.
  const w = { id: '21', title: 'Give A.R.A.: live weather', status: 'done', branch: 'worker/21-live-weather', pushed: 'pushed `worker/21-live-weather` (2 commit(s) ahead of main)', result: 'DONE\nShe has the forecast every turn.\nAUTOFIX_TITLE: A.R.A. always sees the weather' };
  assert.strictEqual(await F.finish(w), true);
  assert.strictEqual(merged.length, 1, 'merged on its own');
  assert.deepStrictEqual(redeploys, ['jarvis'], 'server change → redeploy');
  assert.strictEqual(cards.length, 0, 'no tap needed');
  assert.strictEqual(outOfBand.length, 0, 'she waits for the restart');

  // After the restart she comes back with the answer to his original question.
  await F.followUps();
  assert.strictEqual(outOfBand.length, 1);
  assert.strictEqual(outOfBand[0].id, 'ara');
  assert.match(outOfBand[0].text, /what's the weather tonight\?/);
  assert.match(outOfBand[0].text, /live now/);
  await F.followUps();
  assert.strictEqual(outOfBand.length, 1, 'answered once');

  // A PR touching trading waits for his tap.
  await F.request('atlas', 'see the trade journal by week', { asked: 'how did talon do this week' });
  files = ['server/tradeJournal.js'];
  await F.finish({ id: '22', title: 'Give A.T.L.A.S.: weekly journal', status: 'done', branch: 'worker/22', pushed: 'pushed `worker/22` (1 commit(s) ahead of main)', result: 'DONE\nx\nAUTOFIX_TITLE: Weekly journal' });
  assert.strictEqual(merged.length, 1, 'not merged on its own');
  assert.strictEqual(cards.length, 1, 'a Merge card instead');

  // Nothing built → she comes back right away and says why.
  await F.request('selene', 'post to instagram directly', { asked: 'post this reel' });
  await F.finish({ id: '23', title: 'Give S.E.L.E.N.E.: post', status: 'done', branch: 'worker/23', pushed: 'no commits', result: 'DONE\nNeeds an Instagram Graph token he has to add.\nAUTOFIX_TITLE: none' });
  assert.strictEqual(outOfBand.length, 2);
  assert.strictEqual(outOfBand[1].id, 'selene');
  assert.match(outOfBand[1].text, /couldn't build it/);
  assert.match(outOfBand[1].text, /Graph token/);

  // Guarded paths
  assert.ok(F.GUARDED.test('server/talonAutoTrade.js') && F.GUARDED.test('.github/workflows/x.yml') && !F.GUARDED.test('server/personaRuntime.js'));
  console.log('feature requests: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
