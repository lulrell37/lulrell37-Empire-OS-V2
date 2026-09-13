// A.T.L.A.S. unprompted money review — server-side port of
// src/services/autoAtlas.js. Since the app's own per-persona chat table isn't
// part of the synced dataset (see server/syncStore.js saveMemory), the "queued
// unread in her chat" delivery the client version uses can't reach the app from
// here; this pushes the review to the owner's phone instead (server/pushSender)
// and — same as the client — hands the finished read straight to A.R.A.'s
// memory so she can fold it into how she runs the day, per her own instruction
// to flag anything slipping.
const { chatAs } = require('./llm');
const { getSetting, setSetting, saveMemory } = require('./syncStore');
const { gatherContext, contextBlock } = require('./personaRuntime');
const { formatTradeRecord } = require('./tradeJournal');
const { pushAlert } = require('./pushSender');

let busy = false;

async function statusBlock() {
  const ctx = await gatherContext();
  const block = contextBlock(ctx);
  const trade = await formatTradeRecord().catch(() => '');
  return trade ? `${block}\n\nT.A.L.O.N. trade record:\n${trade}` : block;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if ((await getSetting('auto_atlas', '0')) !== '1') return;
    const hours = Math.max(1, parseInt(await getSetting('auto_atlas_interval_hours', '24'), 10) || 24);
    const lastRun = parseInt(await getSetting('auto_atlas_last_run', '0'), 10) || 0;
    if (Date.now() - lastRun < hours * 3600000) return; // not due yet

    const status = await statusBlock().catch(() => '');
    if (!status.trim()) return;

    const ask = [{ role: 'user', content:
`This is your own periodic money review — nobody asked, it fires on your schedule. Here is the live cross-domain status:\n${status}\n\n` +
`Give Mr. Burrus a tight, unprompted read: what's actually working, what's slipping, and the ONE thing most worth his attention right now — a business lagging its target, cash sitting idle, momentum worth pressing, trading or outreach numbers that changed the picture. End on one concrete recommendation. A few sentences — this is a nudge, not a report. Be straight; don't manufacture urgency if nothing has actually moved.` }];
    let resp = '';
    try { resp = await chatAs('anthropic', null, 'You are A.T.L.A.S., the Empire\'s cross-domain money read — sharp, concise, numbers-first.', ask, { maxTokens: 500 }); }
    catch (e) { console.error('auto-atlas: review call failed', e.message); return; }
    const display = String(resp || '').trim();
    if (!display) return;

    await saveMemory('atlas', `[auto money review] ${display}`);
    // A.R.A. runs the day and already gets the raw cross-domain numbers every
    // turn — hand her the finished analysis too, not just the figures.
    await saveMemory('ara', `[relayed from A.T.L.A.S. — auto money review] ${display}`);
    await setSetting('auto_atlas_last_run', String(Date.now()));
    console.log('auto-atlas: review —', display.slice(0, 160));
    await pushAlert(`atlas:${lastRun}`, 'A.T.L.A.S. — money review', display.slice(0, 180), { kind: 'atlas' }).catch(() => {});
  } catch (e) {
    console.error('auto-atlas: tick crashed', e.message);
  } finally {
    busy = false;
  }
}

module.exports = { tick };
