'use strict';
// New-venture pipeline (owner's standing order, 2026-11-23): when he says he wants to start anything, the Empire
// runs a fixed order, driven by code so no persona can skip a step:
//   1) S.A.G.E. researches it  2) if it makes money, A.T.L.A.S. adds the business + sets targets
//   3) the lane owners each do their part  4) the combined result goes back into the asking persona's turn.
// Its own bounded run: five hand-offs at depth 1 (they may relay twice more, MAX_RELAY_DEPTH still applies), never
// anything that sends/posts/buys/deletes/trades without his OK (those tags need his Confirm / own message anyway).
// `VENTURE=off` stops it. node server/scripts/test-venture.js
const { detectVenture, LANES_FOR_VENTURE } = require('./personas');

const enabled = () => String(process.env.VENTURE || '').toLowerCase() !== 'off';
const SKIP = new Set(['ara', 'sage', 'atlas']);

// Always asked on a money venture / on any venture; others join when his words fall in their lane.
const CORE_LANES = {
  selene: 'the name, brand, look and pitch',
  scribe: 'the copy: bio, tagline, first posts or scripts, whatever words it needs',
  aisha: 'the legal and policy side: entity, licenses, terms, risks',
  scout: 'the leads: who the first customers or clients are and how to reach them',
};
const MAX_LANES = 6;

// Which lane owners touch this venture, in order (never the asker's own step twice, never S.A.G.E./A.T.L.A.S./A.R.A.).
function laneOwners(text, { money = true, asker = 'ara' } = {}) {
  const said = String(text || '').toLowerCase().replace(/\./g, '');
  const out = [];
  const add = (id, what) => { if (!SKIP.has(id) && id !== asker && !out.some((x) => x.id === id)) out.push({ id, what }); };
  for (const [id, what] of Object.entries(CORE_LANES)) {
    if (!money && (id === 'scout')) continue; // no customers to chase when it isn't a money venture
    add(id, what);
  }
  for (const [id, re] of Object.entries(LANES_FOR_VENTURE)) if (re.test(said)) add(id, 'the part of it in your lane');
  return out.slice(0, MAX_LANES);
}

// S.A.G.E. ends her research with "MONEY: yes|no"; no line means yes (money is the default for a venture).
function makesMoney(research) {
  const m = /MONEY:\s*(yes|no)\b/i.exec(String(research || ''));
  return !m || m[1].toLowerCase() === 'yes';
}
const stripMoney = (s) => String(s || '').replace(/^\s*MONEY:\s*(yes|no)\b.*$/gim, '').trim();

const cut = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// deps: { relay(id, message) -> text, hasBusiness(textHint) -> bool|name, progress? }. Returns the ordered steps.
async function runVenture(said, { asker = 'ara', relay, businesses, step = () => {} } = {}) {
  const steps = []; // { id, order, what, text, ok }
  const ask = async (order, id, what, message) => {
    step(order, id);
    try { const text = await relay(id, message); steps.push({ order, id, what, text: String(text || ''), ok: true }); return String(text || ''); }
    catch (e) { console.error(`venture failed: ${id}: ${e.message}`); steps.push({ order, id, what, text: `couldn't do it: ${e.message}`, ok: false }); return ''; }
  };
  const base = `[NEW VENTURE — Mr. Burrus told ${asker === 'ara' ? 'A.R.A.' : asker} his words: "${cut(said, 700)}". The Empire runs this in a fixed order; you are one step of it. Do your part now with your tools. Sending, posting, buying, deleting and trading still need his OK.]`;

  const research = await ask(1, 'sage', 'research',
    `${base}\nSTEP 1, YOURS FIRST: research everything you can find about this area: what it is, how it makes money, what people earn, the competition, costs to start, the risks, the first steps. Use web research, save it as a Drive note "Venture — <name>" if you can. Be concrete, with numbers and sources. Give a suggested name for the business line. End with exactly one line "MONEY: yes" or "MONEY: no" (does it make money?).`);
  const money = makesMoney(research);

  let added = null;
  if (money) {
    const msg = `${base}\nSTEP 2, YOURS: S.A.G.E.'s research is below. If this makes money, add it to the business list with [ADD_BUSINESS: name | monthly | weekly | note] and set realistic monthly and weekly targets from her numbers (dollars, plain numbers). Then say what you set and why, in two or three lines.\n\n[S.A.G.E.'S RESEARCH]\n${cut(stripMoney(research), 6000)}`;
    await ask(2, 'atlas', 'business + targets', msg);
    added = businesses ? await businesses().catch(() => null) : null;
    if (businesses && !added) {
      // she answered but nothing landed: one more ask, then say so in the result.
      await ask(2, 'atlas', 'business + targets (retry)', `${msg}\n\n[Nothing was added last time. Emit the [ADD_BUSINESS: …] tag now.]`);
      added = await businesses().catch(() => null);
    }
  }

  const sage = cut(stripMoney(research), 3500);
  const atlas = (steps.filter((s) => s.id === 'atlas').pop() || {}).text || '';
  const lanes = laneOwners(said, { money, asker });
  const ctx = `[S.A.G.E.'S RESEARCH]\n${sage}${atlas ? `\n\n[A.T.L.A.S.'S TARGETS]\n${cut(atlas, 1200)}` : ''}`;
  const laneRuns = await Promise.all(lanes.map((l) => (async () => {
    const text = await (async () => {
      step(3, l.id);
      try { return String(await relay(l.id, `${base}\nSTEP 3, YOURS: ${l.what}, for this venture, from your lane only. Use S.A.G.E.'s research${money ? " and A.T.L.A.S.'s targets" : ''}. Do the work, don't ask him questions. Keep it concrete.\n\n${ctx}`) || ''); }
      catch (e) { console.error(`venture failed: ${l.id}: ${e.message}`); return { fail: e.message }; }
    })();
    return { order: 3, id: l.id, what: l.what, text: text.fail ? `couldn't do it: ${text.fail}` : text, ok: !text.fail };
  })()));
  steps.push(...laneRuns);
  return { money, added, steps, lanes: lanes.map((l) => l.id) };
}

// What goes back into the asker's turn (step 4): the combined result, to be reported to him.
function resultBlock(r, asker = 'ara') {
  const name = (id) => (require('./personas').ROSTER[id] || {}).name || id;
  const lines = r.steps.map((s) => `${s.order}) ${name(s.id)} (${s.what})${s.ok ? '' : ' ⚠️'}:\n${cut(stripMoney(s.text), 1400)}`);
  const biz = r.money ? (r.added ? `\nBusiness list: ${r.added} is on it.` : '\n⚠️ A.T.L.A.S. did not get the business onto the list.') : '\nS.A.G.E. says it does not make money, so no business line or targets.';
  return `[NEW VENTURE RESULT — the Empire ran it in the fixed order (S.A.G.E. → A.T.L.A.S. → lane owners). Report this to Mr. Burrus as ${asker === 'ara' ? 'A.R.A.' : 'yourself'}: what each did, the numbers, the one decision or OK you need from him if any. Don't redo any of it, don't claim anything beyond these receipts.]\n${lines.join('\n\n')}${biz}`;
}

module.exports = { enabled, detectVenture, laneOwners, makesMoney, runVenture, resultBlock, CORE_LANES };
