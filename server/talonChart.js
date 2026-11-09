// [TRADE_CHART: XAUUSD | 1H] — T.A.L.O.N.'s marked-up chart as a PNG for
// Telegram: candles, FVGs, order blocks, liquidity, sweeps, BOS/CHoCH, trend lines,
// swing and current highs/lows, key levels and our open positions. server/marketStructure.js finds and lays out everything;
// this turns its drawing model into a Vega-Lite spec that Kroki renders (the same
// service [DIAGRAM] uses, so no new dependency). Read-only: never touches a trade.
const { tlHistory, tlQuote } = require('./tradeLocker');
const { closedBars, analyzeStructure, keyLevels, chartModel, formatTimeframe } = require('./marketStructure');
const { allTrades } = require('./tradeJournal');

const TFS = { '5M': '5m', '15M': '15m', '1H': '1H', '4H': '4H', '1D': '1D', D: '1D', H1: '1H', H4: '4H', M15: '15m', M5: '5m' };
const ALIAS = { GOLD: 'XAUUSD', XAU: 'XAUUSD', BTC: 'BTCUSD', BITCOIN: 'BTCUSD', XBT: 'BTCUSD' };

function parseArg(arg) {
  const parts = String(arg || '').split(/[|,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const tfAt = parts.findIndex((p) => TFS[p]);
  const tf = tfAt >= 0 ? TFS[parts[tfAt]] : '1H';
  const raw = parts.find((_, i) => i !== tfAt) || 'XAUUSD';
  return { symbol: ALIAS[raw] || raw.replace(/[^A-Z0-9]/g, ''), tf };
}

// Drawing model -> Vega-Lite. Every layer shares the same fixed scales.
function vegaSpec(m) {
  const x = { field: 'x', type: 'quantitative', axis: null, scale: { domain: [-1, m.xMax], nice: false, zero: false } };
  const y = { field: 'y', type: 'quantitative', scale: { domain: [m.yMin, m.yMax], nice: false, zero: false },
    axis: { title: null, orient: 'left', grid: true, gridColor: '#1c1a16', labelColor: '#8a8578', domainColor: '#2a2620', tickColor: '#2a2620', format: '.2f' } };
  const color = { field: 'color', type: 'nominal', scale: null };
  const layer = (values, mark, encoding) => ({ data: { values }, mark, encoding });
  const lines = (dash) => m.lines.filter((l) => !!l.dash === dash);
  const textLines = m.lines.filter((l) => l.text).map((l) => ({ x: (l.x1 + l.x2) / 2, y: l.y, text: l.text, color: l.color }));
  const body = m.candles.map((c) => ({ x: c.x - 0.32, x2: c.x + 0.32, y: Math.min(c.o, c.c), y2: Math.max(c.o, c.c), color: c.color }));
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 1100, height: 620, background: '#0b0a08', padding: 12,
    title: { text: m.title, subtitle: m.subtitle, color: '#E8C98A', subtitleColor: '#8a8578', anchor: 'start', fontSize: 16, subtitleFontSize: 12 },
    view: { stroke: null },
    layer: [
      layer(m.zones.map((z) => ({ x: z.x1, x2: z.x2, y: z.y1, y2: z.y2, color: z.color, op: z.opacity })), { type: 'rect' },
        { x, x2: { field: 'x2' }, y, y2: { field: 'y2' }, color, opacity: { field: 'op', type: 'quantitative', scale: null } }),
      layer(lines(true).map((l) => ({ x: l.x1, x2: l.x2, y: l.y, color: l.color })), { type: 'rule', strokeDash: [4, 4], strokeWidth: 1, opacity: 0.75 },
        { x, x2: { field: 'x2' }, y, color }),
      layer(lines(false).map((l) => ({ x: l.x1, x2: l.x2, y: l.y, color: l.color, w: l.width || 1 })), { type: 'rule' },
        { x, x2: { field: 'x2' }, y, color, strokeWidth: { field: 'w', type: 'quantitative', scale: null } }),
      layer(m.trends.flatMap((t, id) => [[t.x1, t.y1], [t.x2, t.y2]].map(([px, py]) => ({ id, x: px, y: py - t.zone, y2: py + t.zone, color: t.color }))), { type: 'area', opacity: 0.18, clip: true },
        { x, y, y2: { field: 'y2' }, color, detail: { field: 'id', type: 'nominal' } }),
      layer(m.trends.flatMap((t, id) => [{ id, x: t.x1, y: t.y1, color: t.color }, { id, x: t.x2, y: t.y2, color: t.color }]), { type: 'line', strokeWidth: 2, clip: true },
        { x, y, color, detail: { field: 'id', type: 'nominal' } }),
      layer(m.candles.map((c) => ({ x: c.x, y: c.l, y2: c.h, color: c.color })), { type: 'rule', strokeWidth: 1 },
        { x, y, y2: { field: 'y2' }, color }),
      layer(body, { type: 'rect' }, { x, x2: { field: 'x2' }, y, y2: { field: 'y2' }, color }),
      layer(m.marks.map((k) => ({ x: k.x, y: k.y, color: k.color, shape: k.up ? 'triangle-up' : 'triangle-down' })), { type: 'point', filled: true, size: 70, opacity: 1 },
        { x, y, color, shape: { field: 'shape', type: 'nominal', scale: null } }),
      layer(m.marks.map((k) => ({ x: k.x, y: k.y, color: k.color, text: k.text, dy: k.up ? 14 : -14 })).filter((k) => k.dy > 0), { type: 'text', fontSize: 10, dy: 14 },
        { x, y, color, text: { field: 'text' } }),
      layer(m.marks.map((k) => ({ x: k.x, y: k.y, color: k.color, text: k.text, dy: k.up ? 14 : -14 })).filter((k) => k.dy < 0), { type: 'text', fontSize: 10, dy: -14 },
        { x, y, color, text: { field: 'text' } }),
      layer(m.tags.filter((k) => k.up), { type: 'text', fontSize: 10, fontWeight: 'bold', dy: 11 }, { x, y, color, text: { field: 'text' } }),
      layer(m.tags.filter((k) => !k.up), { type: 'text', fontSize: 10, fontWeight: 'bold', dy: -11 }, { x, y, color, text: { field: 'text' } }),
      layer(textLines, { type: 'text', fontSize: 9, dy: -6 }, { x, y, color, text: { field: 'text' } }),
      layer(m.labels.map((l) => ({ x: m.xLabel, y: l.y, text: l.text, color: l.color })), { type: 'text', align: 'left', fontSize: 11 },
        { x, y, color, text: { field: 'text' } }),
    ],
  };
}

async function renderPng(model) {
  const res = await fetch('https://kroki.io/vegalite/png', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(vegaSpec(model)), signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`kroki ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function buildChart(arg) {
  const { symbol, tf } = parseArg(arg);
  const [bars, daily, m15, quote, trades] = await Promise.all([
    tlHistory(symbol, tf, 150),
    tlHistory(symbol, '1D', 120).catch(() => []),
    tlHistory(symbol, '15m', 192).catch(() => []),
    tlQuote(symbol).catch(() => null),
    allTrades().catch(() => []),
  ]);
  if (!bars?.length) throw new Error(`no ${tf} candles for ${symbol}`);
  const closed = closedBars(bars, tf);
  const structure = analyzeStructure(closed);
  const price = Number(quote?.mid ?? bars[bars.length - 1].c);
  const levels = keyLevels({ symbol, daily: closedBars(daily, '1D'), m15: closedBars(m15, '15m'), price });
  const positions = trades.filter((t) => t.status === 'open' && t.symbol === symbol).map((t) => ({
    label: t.setup || t.side, entry: t.entry_fill ?? t.entry_ref, stop: t.be_stop ?? t.stop_loss, target: t.take_profit,
  }));
  const model = chartModel({ symbol, tf, bars, structure, levels, positions });
  return { png: await renderPng(model), caption: formatTimeframe(tf, structure, price).slice(0, 1000), symbol, tf };
}

module.exports = { buildChart, parseArg, vegaSpec };
