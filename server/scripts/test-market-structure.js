// Checks server/marketStructure.js against candles built to contain each pattern,
// and that the app's copy hasn't drifted from it. No network, no keys.
//
//   node server/scripts/test-market-structure.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ms = require('../marketStructure');

const H = 3600e3;
const T0 = Date.UTC(2026, 10, 2, 0);
// [o, h, l, c] rows -> bars, one hour apart.
const mk = (rows) => rows.map(([o, h, l, c], i) => ({ t: T0 + i * H, o, h, l, c }));
const flat = (p, n) => Array.from({ length: n }, () => [p, p + 1, p - 1, p]);

// Bullish FVG: candle 1 high 101, candle 3 low 104.
{
  const st = ms.analyzeStructure(mk([...flat(100, 12), [100, 101, 99, 101], [101, 110, 100.5, 109], [109, 112, 104, 111], [111, 113, 110, 112], [112, 114, 111, 113]]));
  const f = st.fvgs.find((x) => x.low === 101 && x.high === 104);
  assert(f, 'bullish FVG found');
  assert.strictEqual(f.dir, 1);
  assert.strictEqual(f.ce, 102.5);
  assert.strictEqual(f.status, 'open');
}
// That FVG partly filled, then closed through (inverted to bearish).
{
  const base = [...flat(100, 12), [100, 101, 99, 101], [101, 110, 100.5, 109], [109, 112, 104, 111]];
  const part = ms.analyzeStructure(mk([...base, [111, 111, 103, 110]])).fvgs.find((x) => x.low === 101);
  assert.strictEqual(part.status, 'partial');
  const inv = ms.analyzeStructure(mk([...base, [111, 111, 95, 96]])).fvgs.find((x) => x.low === 101);
  assert.strictEqual(inv.status, 'inverted');
  assert.strictEqual(inv.dir, -1);
}
// Swing high at 110: wick to 112 and close back under = buy-side sweep; a close
// over it is a break, and not a sweep.
{
  const up = [[100, 101, 99, 100], [100, 102, 99, 101], [101, 105, 100, 104], [104, 110, 103, 106], [106, 107, 102, 103], [103, 105, 101, 102], [102, 104, 100, 103], [103, 106, 102, 105], [105, 107, 103, 104], [104, 108, 103, 105]];
  const swept = ms.analyzeStructure(mk([...up, [105, 112, 104, 106], [106, 107, 103, 104]]));
  const s = swept.sweeps.find((x) => x.level === 110);
  assert(s, 'sweep found');
  assert.strictEqual(s.side, 'buy');
  assert.strictEqual(s.implied, -1);
  assert.strictEqual(s.held, true);
  const broke = ms.analyzeStructure(mk([...up, [105, 112, 104, 111], [111, 113, 110, 112]]));
  assert(!broke.sweeps.some((x) => x.level === 110), 'a close beyond is not a sweep');
  assert(broke.events.some((e) => e.dir === 1 && e.level === 110), 'close above the swing breaks structure');
  const failed = ms.analyzeStructure(mk([...up, [105, 112, 104, 106], [106, 114, 105, 113]]));
  assert.strictEqual(failed.sweeps.find((x) => x.level === 110).held, false);
}
// A BOS up, then the first close under a swing low is a CHoCH.
{
  const st = ms.analyzeStructure(mk([
    [100, 101, 99, 100], [100, 103, 99, 102], [102, 105, 101, 104], [104, 103.5, 102, 103], [103, 103, 101, 102], [102, 103, 100.5, 101],
    [101, 106, 100.8, 105.5], [105.5, 108, 105, 107], [107, 107.5, 104, 104.5], [104.5, 105, 103, 103.5], [103.5, 104, 102.5, 103], [103, 103.5, 99, 99.5], [99.5, 100, 98, 98.5],
  ]));
  assert(st.events.some((e) => e.type === 'BOS' && e.dir === 1), 'BOS up');
  const ch = st.events.find((e) => e.type === 'CHoCH');
  assert(ch && ch.dir === -1, 'CHoCH down');
  assert.strictEqual(st.bias, 'bear');
}
// Two matching highs = one EQH pool.
{
  const st = ms.analyzeStructure(mk([
    [100, 101, 99, 100], [100, 102, 99, 101], [101, 110, 100, 105], [105, 106, 102, 103], [103, 104, 101, 102], [102, 106, 101, 105], [105, 110.05, 104, 106], [106, 107, 103, 104], [104, 105, 102, 103], [103, 104, 101, 102], [102, 103, 100, 101],
  ]));
  const p = st.pools.find((x) => x.kind === 'EQH');
  assert(p, 'EQH pool found');
  assert.strictEqual(p.price, 110.05);
  assert.strictEqual(p.touches, 2);
}
// A pool a later wick has taken is no longer resting.
{
  const up = [[100, 101, 99, 100], [100, 102, 99, 101], [101, 105, 100, 104], [104, 110, 103, 106], [106, 107, 102, 103], [103, 105, 101, 102], [102, 104, 100, 103], [103, 106, 102, 105], [105, 107, 103, 104], [104, 108, 103, 105]];
  const st = ms.analyzeStructure(mk([...up, [105, 110.2, 104, 106]]));
  assert(!st.pools.some((p) => p.side === 'buy' && p.price === 110), 'taken pool dropped');
}
// Order block: the down candle before a displaced up move through a swing.
{
  const st = ms.analyzeStructure(mk([
    [100, 101, 99, 100], [100, 102, 99.5, 101], [101, 104, 100.5, 103], [103, 103.5, 101.5, 102], [102, 102.5, 100.5, 101], [101, 101.5, 99.8, 100.2],
    [100.2, 112, 100, 111], [111, 113, 110.5, 112], [112, 114, 111, 113],
    [113, 113.5, 112, 112.5], [112.5, 113, 111.5, 112],
  ]));
  const ob = st.orderBlocks.find((o) => o.kind === 'ob' && o.dir === 1);
  assert(ob, 'bullish OB found');
  assert.strictEqual(ob.low, 99.8);
  assert.strictEqual(ob.status, 'fresh');
}
// Premium and discount off the current leg.
{
  const legUp = Array.from({ length: 30 }, (_, i) => [100 + i, 101 + i, 99 + i, 100.8 + i]);
  const st = ms.analyzeStructure(mk(legUp));
  assert.strictEqual(st.range.zone, 'premium');
  assert(st.range.ote[0] < st.range.ote[1] && st.range.ote[1] < st.range.eq);
}
// Forming candles are excluded; a session or day taken out is marked.
{
  const now = T0 + 10 * H + 5 * 60e3;
  const bars = mk(flat(100, 11));
  assert.strictEqual(ms.closedBars(bars, '1H', now).length, 10);
  const day = 86400e3;
  const daily = [{ t: T0 - 2 * day, o: 100, h: 110, l: 90, c: 100 }, { t: T0 - day, o: 100, h: 105, l: 95, c: 100 }];
  const m15 = [{ t: T0 + H, o: 100, h: 106, l: 99, c: 100 }];
  const lv = ms.keyLevels({ symbol: 'XAUUSD', daily, m15, price: 103, now: T0 + 2 * H });
  assert.strictEqual(lv.find((l) => l.label === 'PDH').taken, true);
  assert.strictEqual(lv.find((l) => l.label === 'PDL').taken, false);
  assert(lv.some((l) => l.label === 'Round' && l.price === 110));
  assert(lv.some((l) => l.label === 'Major round' && l.price === 100));
}
// The stop's danger zone.
{
  const swings = [{ type: 'low', price: 4006 }, { type: 'high', price: 4030 }];
  const z = ms.zoneStop({ symbol: 'XAUUSD', side: 'buy', entry: 4012, sma20: 4004, atr: 5, swings });
  assert.strictEqual(z.boundary, 4000, 'furthest of SMA20, round number and swing');
  assert.strictEqual(z.stop, 3999);
  assert.strictEqual(z.tooWide, false);
  // A sell looks up, and a level on the profit side doesn't count.
  const s = ms.zoneStop({ symbol: 'XAUUSD', side: 'sell', entry: 3990, sma20: 3980, atr: 5, swings: [{ type: 'high', price: 3996 }] });
  assert.strictEqual(s.boundary, 4000);
  assert.strictEqual(s.stop, 4001);
  // The most recent swing is the one that counts.
  assert.strictEqual(ms.zoneStop({ symbol: 'BTCUSD', side: 'buy', entry: 100400, atr: 100, swings: [{ type: 'low', price: 99000 }, { type: 'low', price: 100300 }] }).boundary, 100300);
  assert.strictEqual(ms.zoneStop({ symbol: 'XAUUSD', side: 'buy', entry: 4012, sma20: 3970, atr: 5 }).tooWide, true, 'past gold $35');
  assert.strictEqual(ms.zoneStop({ symbol: 'EURUSD', side: 'buy', entry: 1.1 }), null, 'gold and Bitcoin only');
}

// Too little history is null, not a crash; the read then stays empty.
assert.strictEqual(ms.analyzeStructure(mk(flat(100, 5))), null);
assert.strictEqual(ms.formatMarketRead({ structure: null, levels: [], price: 100 }), '');

// The app's copy is the same code.
const body = (file) => {
  const s = fs.readFileSync(path.join(__dirname, file), 'utf8');
  return s.slice(s.indexOf('const TF_MS'), s.search(/^(module\.exports|export \{)/m));
};
assert.strictEqual(body('../marketStructure.js'), body('../../src/services/marketStructure.js'), 'src/services/marketStructure.js has drifted');

console.log('market structure: all checks passed');
