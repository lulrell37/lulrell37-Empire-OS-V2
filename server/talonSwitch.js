// T.A.L.O.N.'s off switch (owner, 2026-11-26: "I told A.R.A. to have Talon stop
// trading and hours later he starts again. If I say stop it should switch off until
// I say start again").
//
// Before this there was no tag for it: T.A.L.O.N. and A.R.A. could only say "okay",
// the synced `auto_trade` toggle stayed on, and his next cycle traded. W.I.R.E.'s news
// trades didn't check `auto_trade` at all.
//
// [TRADING_OFF] (A.R.A. and J.A.R.V.I.S. only, owner 2026-11-26; T.A.L.O.N. relays it to her) sets `talon_halt` = 1 and
// `auto_trade` = 0 and cancels his resting quick-scalp limits. While halted,
// tlPlaceOrder refuses every automatic order: setups, add-ons, quick scalps,
// re-entries, news trades and the Nasdaq desk. Only an order he gives by hand
// ([TRADE_ENTER], `manual: true`) goes through. Open positions keep their broker stop and target;
// closing them is [TRADE_CLOSE]. [TRADING_ON] runs only on his own message that says
// start / resume / turn on (never a wake-up, a loop or a persona's own idea).
// node server/scripts/test-talon-switch.js.
const { getSetting, setSetting } = require('./syncStore');

let deps = null;
const d = () => deps || {
  getSetting, setSetting,
  cancelQuickLimits: async () => {
    const raw = await getSetting('talon_quick_pending', '[]').catch(() => '[]');
    let list = [];
    try { list = JSON.parse(raw || '[]') || []; } catch { list = []; }
    let n = 0;
    for (const p of list) {
      try { await require('./tradeLocker').tlCancelOrder(p.orderId); n++; } catch (e) { console.error(`talon switch failed: cancelling limit ${p.orderId}: ${e.message}`); }
    }
    if (list.length) await setSetting('talon_quick_pending', '[]');
    return n;
  },
};

async function isHalted() {
  return String(await d().getSetting('talon_halt', '0')) === '1';
}

// His own words turning trading back on. Not "don't start", not a question.
const START = /\b(start|resume|restart|turn (it |him |trading |talon )?(back )?on|switch (it |him |trading )?(back )?on|back on|un-?pause|unhalt|let (him|talon) trade|go back to trading|start trading again)\b/i;
const NOT = /\b(don'?t|do not|never|no)\s+(start|resume|turn|switch)|\?\s*$/i;
const ownerStarts = (t) => START.test(String(t || '')) && !NOT.test(String(t || ''));

async function off({ by = '', why = '' } = {}) {
  await d().setSetting('talon_halt', '1');
  await d().setSetting('auto_trade', '0');
  await d().setSetting('talon_halt_at', JSON.stringify({ at: Date.now(), by, why: String(why).slice(0, 200) }));
  const n = await d().cancelQuickLimits().catch((e) => { console.error(`talon switch failed: ${e.message}`); return 0; });
  return `TRADING_OFF: ✓ T.A.L.O.N. is switched OFF and stays off until Mr. Burrus says start. No new trades of any kind (setups, add-ons, quick scalps, re-entries, news trades, Nasdaq)${n ? `; ${n} resting limit order${n === 1 ? '' : 's'} cancelled` : ''}. Open positions keep their stops and targets — close them with [TRADE_CLOSE] if he wants out.`;
}

async function on() {
  await d().setSetting('talon_halt', '0');
  await d().setSetting('auto_trade', '1');
  return 'TRADING_ON: ✓ T.A.L.O.N. is switched back ON — he trades again from his next cycle.';
}

// The tag, from runInjections. asked = his own message this turn ('' for loops / wake-ups).
async function tag(name, persona, { asked = '' } = {}) {
  if (!['ara', 'jarvis'].includes(persona) && name !== 'TRADING_STATUS') return `${name}: only A.R.A. and J.A.R.V.I.S. switch T.A.L.O.N. on or off — [RELAY_TO: ara | Mr. Burrus says: ${String(asked || '').slice(0, 200)}]. Nothing changed.`;
  if (name === 'TRADING_OFF') return off({ by: persona, why: asked });
  if (name === 'TRADING_ON') {
    if (/^\[(SENT ON YOUR OWN|The server restarted)/.test(String(asked || '')) || !ownerStarts(asked)) {
      return 'TRADING_ON refused: T.A.L.O.N. stays OFF — only Mr. Burrus\'s own words ("start trading", "turn Talon back on") switch him on. Nothing changed.';
    }
    return on();
  }
  if (name === 'TRADING_STATUS') {
    if (!(await isHalted())) return `TRADING_STATUS: ON (auto-trade ${String(await d().getSetting('auto_trade', '0')) === '1' ? 'on' : 'off in Settings'}).`;
    let h = {};
    try { h = JSON.parse(await d().getSetting('talon_halt_at', '{}')) || {}; } catch { h = {}; }
    return `TRADING_STATUS: OFF since ${h.at ? new Date(h.at).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' : 'earlier'} — waiting for him to say start.`;
  }
  return '';
}

const SWITCH_TOOLS = ` - [TRADING_OFF] — switch T.A.L.O.N. OFF the moment Mr. Burrus says stop trading / stop Talon / pause trading: no new trades of any kind until he says start, and his resting limit orders are cancelled. Open positions stay with their stops (add [TRADE_CLOSE: all] only if he says close them). Never just say he stopped: it hasn't happened unless this tag ran.
 - [TRADING_ON] — switch him back on, only when Mr. Burrus himself says start / resume / turn Talon back on.
 - [TRADING_STATUS] — whether T.A.L.O.N. is on or switched off, and since when.`;

module.exports = { isHalted, off, on, tag, ownerStarts, SWITCH_TOOLS, _setDeps: (x) => { deps = x; } };
