// Checks the rules behind A.T.L.A.S.'s stock calls, S.E.L.E.N.E.'s account stats and
// S.C.R.I.B.E.'s script parsing. No network, no keys.
//
//   node server/scripts/test-desks.js
const assert = require('assert');
const { validatePick, stepPick, tradable, recordLine, summarize } = require('../stockData');
const { mediaStats, cleanHandle } = require('../seleneTrends');
const { parseScripts } = require('../scribeMonday');
const { confirmScript } = require('../telegramMedia');
const { guardStop } = require('../talonBrain');
const { bottomLine, parseStories } = require('../wokeRead');

const NOW = Date.UTC(2026, 10, 6, 15);
const DAY = 86400e3;
const date = (d) => new Date(NOW + d * DAY).toISOString().slice(0, 10);
const snap = (over = {}) => ({ ticker: 'ABC', name: 'Abc Inc', type: 'EQUITY', currency: 'USD', price: 100, atr: 2, dollarVolume: 5e8, ...over });
const raw = (over = {}) => ({ horizon: 'short', conviction: 'high', entryLow: 98, entryHigh: 101, stop: 95, target: 112, exitBy: date(30), thesis: 'x', getOutIf: 'y', ...over });

// A sound plan passes, with the math done on the zone's midpoint.
{
  const { pick, skip } = validatePick(raw(), snap(), NOW);
  assert(!skip, skip);
  assert.strictEqual(pick.status, 'watching');
  assert.strictEqual(pick.r, 2.8);
}
// A finished trading day counts as closed the same evening; today's forming one doesn't.
{
  const H = 3600e3;
  const open = NOW - 2 * H; // 2 hours into today's session
  const bars = Array.from({ length: 30 }, (_, i) => {
    const t = open - (29 - i) * DAY;
    return { t, o: 100, h: i === 29 ? 500 : 101, l: 99, c: 100, v: 1e6 };
  });
  const meta = { regularMarketPrice: 100, instrumentType: 'EQUITY', currency: 'USD' };
  assert.strictEqual(summarize('ABC', meta, bars, bars, NOW).structure.n, 29, 'forming day left out');
  assert.strictEqual(summarize('ABC', meta, bars, bars, open + 7 * H).structure.n, 30, 'finished day counted');
}
// Each broken rule rejects it.
const rejects = (r, s, why) => assert(validatePick(raw(r), snap(s), NOW).skip, why);
rejects({ stop: 99 }, {}, 'stop inside the zone');
rejects({ stop: 97.4, entryLow: 98, entryHigh: 99 }, {}, 'stop inside 1× ATR');
rejects({ target: 104 }, {}, 'under 2R');
rejects({ target: 100 }, {}, 'target under the entry');
rejects({ entryLow: 80, entryHigh: 85, stop: 70, target: 120 }, {}, 'entry zone far under price');
rejects({ exitBy: date(-1) }, {}, 'exit date in the past');
rejects({ exitBy: date(60) }, {}, 'short hold past 45 days');
rejects({ conviction: 'low' }, {}, 'low conviction');
rejects({ thesis: '' }, {}, 'no thesis');
rejects({ getOutIf: '' }, {}, 'no exit condition');
rejects({ horizon: 'swing' }, {}, 'unknown horizon');
rejects({}, { price: 94 }, 'already through the stop');
rejects({}, { type: 'CRYPTOCURRENCY' }, 'not a stock or ETF');
rejects({}, { price: 4, atr: 0.1 }, 'penny stock');
rejects({}, { dollarVolume: 1e6 }, 'thin');
rejects({}, { currency: 'EUR' }, 'not in dollars');
assert(tradable(null));
// A long call needs a wider stop and can run for years.
assert(validatePick(raw({ horizon: 'long', exitBy: date(900) }), snap(), NOW).pick);
assert(validatePick(raw({ horizon: 'long', exitBy: date(900) }), snap({ atr: 4 }), NOW).skip, 'long stop inside 2× ATR');

// The life of a call.
{
  let p = validatePick(raw(), snap({ price: 103 }), NOW).pick;
  assert.strictEqual(stepPick(p, 103, NOW).event, null, 'waits above the zone');
  let s = stepPick(p, 100, NOW + 3600e3);
  assert.strictEqual(s.event, 'entry');
  p = s.pick;
  assert.strictEqual(stepPick(p, 105, NOW + 7200e3).event, null);
  s = stepPick(p, 94, NOW + 7200e3);
  assert.strictEqual(s.event, 'stop');
  assert.strictEqual(s.pick.outcome, 'loss');
  assert.strictEqual(s.pick.rMade, -1.2);
  s = stepPick(p, 113, NOW + 7200e3);
  assert.strictEqual(s.event, 'target');
  assert.strictEqual(s.pick.outcome, 'win');
  s = stepPick(p, 101, NOW + 40 * DAY);
  assert.strictEqual(s.event, 'time');
  assert.strictEqual(s.pick.status, 'closed');
  assert.strictEqual(stepPick(s.pick, 50, NOW + 41 * DAY).event, null, 'closed calls stay closed');
}
// A call that never gets its entry is off, and it never counts in the record.
{
  const p = validatePick(raw(), snap({ price: 103 }), NOW).pick;
  assert.strictEqual(stepPick(p, 103, NOW + 8 * DAY).pick.status, 'cancelled');
  assert.strictEqual(stepPick(p, 94, NOW + DAY).pick.status, 'cancelled');
  assert(/No closed calls/.test(recordLine([stepPick(p, 94, NOW + DAY).pick])));
}

// Instagram stats.
{
  const iso = (d) => new Date(NOW - d * DAY).toISOString();
  const s = mediaStats([
    { timestamp: iso(1), like_count: 100, comments_count: 10, media_product_type: 'REELS', caption: 'best', permalink: 'u' },
    { timestamp: iso(5), like_count: 50, comments_count: 0, media_type: 'IMAGE' },
    { timestamp: iso(30), like_count: 20, comments_count: 0, media_type: 'IMAGE' },
  ], NOW);
  assert.strictEqual(s.postsPerWeek, 1);
  assert.strictEqual(s.daysSinceLast, 1);
  assert.strictEqual(s.avgEngagement, 60);
  assert.strictEqual(s.top.caption, 'best');
  assert.strictEqual(mediaStats([], NOW), null);
  assert.strictEqual(cleanHandle('@Some.Creator'), 'some.creator');
  assert.strictEqual(cleanHandle('https://www.instagram.com/abc_1/'), 'abc_1');
  assert.strictEqual(cleanHandle('bad){x}'), '');
}

// W.O.K.E.'s spoken line.
assert.strictEqual(bottomLine('**Tariffs**\n**Real:** x\n**Bottom line:** Mostly true, oversold.'), 'Mostly true, oversold.');
assert.strictEqual(bottomLine('Just one line'), 'Just one line');
assert.strictEqual(bottomLine(''), '');

// W.O.K.E.'s X scan.
assert.deepStrictEqual(parseStories('NONE'), { text: '', stories: [] });
assert.deepStrictEqual(parseStories(''), { text: '', stories: [] });
assert.deepStrictEqual(parseStories('Story A claims x\nSTORIES: ["A", "B"]'), { text: 'Story A claims x', stories: ['A', 'B'] });
assert.deepStrictEqual(parseStories('Story A\nSTORIES: [broken'), { text: 'Story A', stories: [] });
assert.strictEqual(parseStories('NONE of the accounts agree\nSTORIES: ["A"]').stories.length, 0);

// A Confirm card's voice note says what the card says.
{
  const s = confirmScript({ label: 'Send this email', detail: '**To:** a@b.com\nSee https://x.io/y' });
  assert(s.startsWith('Send this email?'));
  assert(s.includes('To: a@b.com') && s.includes('See the link') && !s.includes('**'));
  assert(s.endsWith('Tap Confirm or Cancel.'));
  const long = confirmScript({ label: 'File', detail: 'word '.repeat(3000) }, 100);
  assert(long.length < 180 && long.includes('The rest is in the text.'));
}

// Stops: the bug from issue #3. A $4,001.50 stop passes the flat minimum but sits on $4,000.
{
  const snapG = { candles: { '1H': { atr14: 5, sma20: 4004 } } };
  const buy = { symbol: 'XAUUSD', side: 'buy', entry: 4012, takeProfit: 4040 };
  const g = guardStop({ ...buy, stopLoss: 4001.5, snap: snapG });
  assert.strictEqual(g.stopLoss, 3999, 'pushed past the round number');
  assert.strictEqual(g.widened, true);
  assert(g.note.includes('round number'));
  assert.strictEqual(guardStop({ ...buy, stopLoss: 3995, takeProfit: 4060, snap: snapG }).stopLoss, 3995, 'a stop already clear stays put');
  assert(guardStop({ ...buy, stopLoss: 4001.5, takeProfit: 4020, snap: snapG }).skip, 'the wider stop has to still pay');
  assert(/ceiling/.test(guardStop({ ...buy, stopLoss: 4001.5, snap: { candles: { '1H': { atr14: 5, sma20: 3970 } } } }).skip), 'past gold $35 is skipped');
  // The flat minimum still applies where the zone is close.
  assert.strictEqual(guardStop({ symbol: 'XAUUSD', side: 'buy', entry: 4038, stopLoss: 4034, takeProfit: 4070, snap: { candles: { '1H': { atr14: 2, sma20: 4036 } } } }).stopLoss, 4028);
}

// Script parsing.
{
  const out = parseScripts('=== SCRIPT 1: What is pain ===\nline one\n(look at camera)\n\n=== SCRIPT 2: **Fear** ===\nline two\n');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].title, 'What is pain');
  assert(out[0].body.includes('(look at camera)'));
  assert.strictEqual(out[1].title, 'Fear');
  assert.deepStrictEqual(parseScripts('no format here'), []);
}

console.log('desks: all checks passed');
process.exit(0);
