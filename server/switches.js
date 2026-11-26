// Every loop has a spoken on/off switch (owner, 2026-11-26: "everything should have a
// verbal on or off switch if I say"). Each desk, cron and fan-out has a name here;
// [SWITCH_OFF: name] / [SWITCH_ON: name] (any persona, on his own message only) flip
// app_settings `switch_<key>` and the loop checks isOn(key) before every run
// (`schedule` in index.js, the W.I.R.E. fan-out in newsWire.js). It stays where he put
// it, restarts included, until he says otherwise. T.A.L.O.N.'s trading switch is the
// same one (server/talonSwitch.js: it also blocks every automatic order).
// The env kill switches (`NEWS_WIRE=off` …) are still there for the deployment;
// this is his. Switching something off is never silent: the receipt names it, and
// [SWITCHES] lists what's off. node server/scripts/test-switches.js.
const { getSetting, setSetting } = require('./syncStore');

// key: [what he'd call it, words he might use]
const SWITCHES = {
  trading: ['T.A.L.O.N.\'s trading (all of it: setups, add-ons, quick scalps, re-entries, news trades, Nasdaq)', 'talon trading trades auto-trade autotrade'],
  nasdaq: ['T.A.L.O.N.\'s Nasdaq desk', 'nasdaq nas100 us100 index desk'],
  talon_updates: ['T.A.L.O.N.\'s market updates (9:30, 12:30, 3:30, 6:30)', 'market updates talon updates'],
  trade_recap: ['the 9 PM trading recap', 'recap trade recap nightly recap'],
  news_wire: ['W.I.R.E.\'s news briefs', 'wire news briefs news desk'],
  breaking_watch: ['W.I.R.E.\'s breaking-news alerts', 'breaking news alerts breaking watch'],
  econ_desk: ['W.I.R.E.\'s 8:30 economic data desk', 'econ economic data cpi jobs desk'],
  woke_read: ['W.O.K.E.\'s reads of the news', 'woke reads woke read'],
  woke_x: ['W.O.K.E.\'s X stories', 'x stories twitter woke x'],
  haven_health: ['H.A.V.E.N.\'s health news', 'haven health news health alerts'],
  stock_desk: ['A.T.L.A.S.\'s stock picks', 'atlas stocks stock picks stock desk'],
  auto_atlas: ['A.T.L.A.S.\'s money review', 'atlas review money review auto atlas'],
  money_watch: ['A.T.L.A.S.\'s money watch (Gmail money in/out and the daily report)', 'money watch money report spending'],
  stephanie_quiz: ['S.T.E.P.H.A.N.I.E.\'s multiplication questions', 'quiz multiplication math questions stephanie'],
  instagram_watch: ['S.E.L.E.N.E.\'s Instagram watch', 'instagram watch selene trends'],
  monday_scripts: ['S.C.R.I.B.E.\'s Monday scripts', 'monday scripts scribe scripts'],
  scout_signals: ['S.C.O.U.T.\'s lead finding', 'scout signals leads lead finding'],
  scout_outreach: ['S.C.O.U.T.\'s cold outreach emails', 'outreach cold email scout outreach'],
  site_desk: ['the website desk (S.C.O.U.T. + J.A.R.V.I.S. building sites for local businesses)', 'website desk site desk websites'],
  auto_clip: ['R.O.G.U.E.\'s auto clips', 'auto clips auto clip clips'],
  morning_brief: ['A.R.A.\'s morning brief', 'morning brief'],
  daily_briefing: ['the 5:10 AM daily briefing', 'daily briefing'],
  council: ['the morning council meeting', 'council meeting'],
  day_nudge: ['A.R.A.\'s day nudges (11, 3, 7)', 'day nudges nudge'],
  nudges: ['the 30-minute nudges', 'nudges reminders nudge cycle'],
  word_reminder: ['the word / verse reminders', 'word of the day verse word reminder'],
  reminders: ['his reminders', 'reminders'],
  open_threads: ['the Open Threads tracker', 'open threads'],
  owner_profile: ['the "How Mr. Burrus works" profile updates', 'profile owner profile'],
  build_poll: ['build-job alerts', 'build poll build alerts'],
  sentinel: ['the sentinel (alerts when something breaks)', 'sentinel health alerts'],
};

let deps = null;
const d = () => deps || { getSetting, setSetting };

async function isOn(key) {
  if (key === 'trading') return !(await require('./talonSwitch').isHalted());
  try { return String(await d().getSetting(`switch_${key}`, 'on')) !== 'off'; } catch { return true; } // unreadable → run
}

// The keys a phrase names ("the stock picks", "atlas", "all"). Exact key/name first.
function match(phrase) {
  const p = String(phrase || '').toLowerCase().replace(/[^\w\s.'-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return [];
  if (/^(all|everything|every ?thing|all of (it|them)|all loops|all desks)$/.test(p)) return Object.keys(SWITCHES).filter((k) => !['sentinel', 'reminders'].includes(k));
  if (SWITCHES[p.replace(/ /g, '_')]) return [p.replace(/ /g, '_')];
  const words = p.replace(/\b(the|his|her|my|off|on|switch|turn|stop|start|please)\b/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  let best = []; let bestScore = 0;
  for (const [k, [name, alias]] of Object.entries(SWITCHES)) {
    const hay = `${k.replace(/_/g, ' ')} ${name} ${alias}`.toLowerCase().replace(/\./g, '');
    const score = words.filter((w) => hay.includes(w.replace(/\./g, ''))).length / Math.max(words.length, 1);
    if (score > bestScore) { best = [k]; bestScore = score; } else if (score === bestScore && score > 0) best.push(k);
  }
  return bestScore >= 0.5 ? best : [];
}

const SYSTEM_TURN = /^\[(SENT ON YOUR OWN|The server restarted)/;

async function set(keys, on, { by = '' } = {}) {
  const done = [];
  for (const k of keys) {
    if (k === 'trading') {
      const t = require('./talonSwitch');
      if (on) await t.on(); else await t.off({ by });
    } else await d().setSetting(`switch_${k}`, on ? 'on' : 'off');
    done.push(SWITCHES[k][0]);
  }
  return done;
}

async function tag(name, arg, { asked = '', persona = '' } = {}) {
  if (name === 'SWITCHES') return list();
  const on = name === 'SWITCH_ON';
  if (!String(asked || '').trim() || SYSTEM_TURN.test(String(asked))) return `${name} refused: only Mr. Burrus's own words switch things ${on ? 'on' : 'off'}. Nothing changed.`;
  const keys = match(arg);
  if (!keys.length) return `${name}: no switch called "${arg}". ${list()}`;
  if (keys.length > 3 && !/^(all|everything)/i.test(String(arg).trim())) return `${name}: "${arg}" could be ${keys.map((k) => SWITCHES[k][0]).join('; ')} — ask him which.`;
  if (on && keys.includes('trading') && !require('./talonSwitch').ownerStarts(asked)) return 'SWITCH_ON refused for T.A.L.O.N.\'s trading: only his own "start trading" / "turn Talon back on" does that. Nothing changed.';
  const done = await set(keys, on, { by: persona });
  return `${name}: ✓ ${on ? 'ON' : 'OFF'} — ${done.join('; ')}. ${on ? 'It runs again from its next turn.' : 'It stays off, restarts included, until he says to turn it back on.'}`;
}

async function list() {
  const off = [];
  for (const k of Object.keys(SWITCHES)) if (!(await isOn(k))) off.push(SWITCHES[k][0]);
  return `SWITCHES — OFF now: ${off.length ? off.join('; ') : 'nothing, everything is on'}.\nEvery one he can switch: ${Object.entries(SWITCHES).map(([k, [n]]) => n).join('; ')}.`;
}

const SWITCH_TOOLS = ` - [SWITCH_OFF: what he named] / [SWITCH_ON: what he named] — every loop and desk has a spoken on/off switch (his rule, 2026-11-26): when Mr. Burrus says "stop the stock picks", "turn off the quiz", "switch the breaking news back on", "turn everything off", emit it with his words (e.g. [SWITCH_OFF: stock picks], [SWITCH_OFF: all]). It stays where he puts it, restarts included. Only on his own message. It hasn't happened unless the tag ran — report its receipt.
 - [SWITCHES] — what's switched off right now, and every switch there is.`;

module.exports = { SWITCHES, isOn, match, tag, list, set, SWITCH_TOOLS, _setDeps: (x) => { deps = x; } };
