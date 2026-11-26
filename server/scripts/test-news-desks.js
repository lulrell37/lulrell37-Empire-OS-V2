// S.T.E.P.H.A.N.I.E.'s drill, H.A.V.E.N.'s health watch, W.I.R.E.'s breaking watch
// and A.R.A.'s news block, no network: settings, Telegram, Claude and search stubbed.
// node server/scripts/test-news-desks.js
const assert = require('assert');
const store = require('../syncStore');
const llm = require('../llm');

const settings = {};
store.getSetting = async (k, d) => (k in settings ? settings[k] : d);
store.setSetting = async (k, v) => { settings[k] = v; };
store.saveMemory = async () => {};
let hud = {};
store.syncedRow = async () => hud;
store.upsertSyncRow = async (t, id, row) => { hud = row; };

// Telegram + A.R.A. delivery stubs.
const sent = [];
const telegram = require('../telegram');
telegram.botFor = (id) => ({ isConfigured: () => true, sendMessage: async (chat, text) => { sent.push({ bot: id, text }); } });
const alerts = require('../talonAlerts');
alerts.sendFromAra = async (text) => { sent.push({ bot: 'ara', text }); return true; };
alerts.araNote = (text) => { sent.push({ bot: 'ara', text }); };
require('../pushSender').pushAlert = async () => {};
// newsWire destructures these at require time; the full brief after a break gets nothing back.
llm.webResearch = async () => '';
llm.chatAs = async () => '';

(async () => {
  // --- Stephanie's drill -----------------------------------------------------
  const q = require('../stephanieQuiz');
  for (let lv = 0; lv < q.LEVELS.length; lv++) {
    const set = q.makeQuiz(lv);
    assert.strictEqual(set.length, 5);
    assert.strictEqual(new Set(set.map((x) => `${Math.min(x.a, x.b)}x${Math.max(x.a, x.b)}`)).size, 5, 'no repeats in a set');
    for (const x of set) { assert.strictEqual(x.answer, x.a * x.b); assert.ok(x.a % 10 && x.b % 10, 'no ×10s'); }
  }
  // Waking hours only: 7 AM ET no, 8 AM yes, 10 PM no.
  const et = (h) => new Date(Date.UTC(2026, 10, 26, h + 5, 5)); // EST = UTC-5
  assert.strictEqual(q.inWindow(et(7)), false);
  assert.strictEqual(q.inWindow(et(8)), true);
  assert.strictEqual(q.inWindow(et(22)), false);
  assert.deepStrictEqual(await q.tick({ now: et(3) }), { skipped: 'outside 8 AM-10 PM ET' });
  const r = await q.tick({ now: et(9) });
  assert.ok(r.sent);
  assert.strictEqual(sent[0].bot, 'stephanie');
  assert.ok(/1\. \d+ × \d+ = \?/.test(sent[0].text) && (sent[0].text.match(/ × /g) || []).length === 5);
  const stored = JSON.parse(settings.steph_quiz);
  assert.strictEqual(stored.questions.length, 5);
  const block = await q.quizBlock();
  assert.ok(block.includes(`${stored.questions[0].a} × ${stored.questions[0].b} = ${stored.questions[0].answer}`), 'answer key in her prompt');
  assert.ok(/NOT graded/.test(block));
  // Grading moves the level up on 5/5.
  assert.ok(/scored 5\/5/.test(await q.quizTag('QUIZ_SCORE', '5', '')));
  await q.tick({ now: et(10) });
  assert.strictEqual(JSON.parse(settings.steph_quiz).level, stored.level + 1);
  // Pause needs his own message.
  assert.ok(/only on his own message/.test(await q.quizTag('QUIZ_OFF', '', '')));
  assert.ok(/paused/.test(await q.quizTag('QUIZ_OFF', '', 'stop the quizzes')));
  assert.ok((await q.tick({ now: et(11) })).skipped.includes('paused'));
  await q.quizTag('QUIZ_ON', '', 'start them again');
  assert.ok((await q.tick({ now: et(11) })).sent);
  console.log('✓ stephanie drill');

  // --- H.A.V.E.N. -------------------------------------------------------------
  const haven = require('../havenHealth');
  sent.length = 0;
  assert.deepStrictEqual(await haven.onWireBrief('Markets up.', { ask: async () => 'NOTHING' }), { quiet: true });
  assert.strictEqual(sent.length, 0);
  const reply = 'STORIES:\nSalmonella recall — Costco chicken\n---\nCostco recalled rotisserie chicken in MD over salmonella. Check the lot number before eating any.';
  const h1 = await haven.onWireBrief('…recall…', { ask: async () => reply });
  assert.ok(h1.sent);
  assert.ok(/H\.A\.V\.E\.N\. → A\.R\.A\./.test(sent[0].text) && /Costco/.test(sent[0].text));
  // Same story again stays quiet.
  const h2 = await haven.onWireBrief('…recall…', { ask: async () => reply });
  assert.ok(h2.quiet && h2.repeat);
  assert.strictEqual(sent.length, 1);
  console.log('✓ haven health watch');

  // --- W.I.R.E. breaking watch ------------------------------------------------
  const wire = require('../newsWire');
  assert.deepStrictEqual(wire.parseBreaking('{"breaking": false}'), { breaking: false });
  assert.strictEqual(wire.parseBreaking('no json'), null);
  const p = wire.parseBreaking('ok {"breaking":true,"key":"dc gunman","headline":"Gunman near Union Station, DC","detail":"Police confirm…","source":"Fox 5 DC","severity":"major","dmv":true}');
  assert.ok(p.breaking && p.dmv && p.severity === 'major');
  sent.length = 0;
  const quiet = await wire.breakingWatch({ search: async () => '{"breaking": false}' });
  assert.ok(quiet.quiet);
  const hit = '{"breaking":true,"key":"dc gunman","headline":"Gunman near Union Station, DC","detail":"Police confirm an active shooter; Metro closed.","source":"Fox 5 DC","severity":"major","dmv":true}';
  const b1 = await wire.breakingWatch({ search: async () => hit });
  assert.ok(b1.sent, JSON.stringify(b1));
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(sent.some((m) => /BREAKING/.test(m.text) && /Union Station/.test(m.text)), 'alert went out from A.R.A.');
  const b2 = await wire.breakingWatch({ search: async () => hit });
  assert.ok(b2.quiet && b2.repeat, 'same story never twice');
  assert.ok(JSON.parse(settings.breaking_seen).length >= 1);
  console.log('✓ wire breaking watch');

  // --- A.R.A.'s news block ------------------------------------------------------
  const rt = require('../personaRuntime');
  hud = { news_brief: 'TOP — something happened (Nov 26)', news_updated_at: Date.now() - 10 * 60000 };
  const nb = await rt.newsBlock();
  assert.ok(/W\.I\.R\.E\.'S LATEST BRIEF \(.*10 min ago\)/.test(nb) && /something happened/.test(nb) && !/\[NEWS_NOW\] for a fresh/.test(nb));
  hud.news_updated_at = Date.now() - 3 * 3600e3;
  assert.ok(/over an hour old.*\[NEWS_NOW\]/s.test(await rt.newsBlock()), 'stale brief → fetch a fresh one');
  hud = {};
  assert.ok(/no brief on file.*\[NEWS_NOW\]/.test(await rt.newsBlock()));
  const src = require('fs').readFileSync(require.resolve('../personaRuntime'), 'utf8');
  assert.ok(/persona === 'ara'\) sys = `\$\{sys\}\\n\\n\$\{await newsBlock\(\)\}`/.test(src), 'A.R.A.\'s turn carries the news block');
  assert.ok(/name === 'NEWS_NOW'/.test(src));
  assert.ok(rt.araTools().includes('[NEWS_NOW]'));
  console.log('✓ ara news block wired');
  console.log('all news-desk tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
