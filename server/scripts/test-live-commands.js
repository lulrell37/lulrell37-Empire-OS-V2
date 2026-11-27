// node server/scripts/test-live-commands.js — GO LIVE's run_command runs her tags like a
// Telegram turn (routes/shared.js runLive, owner 2026-11-27).
const assert = require('assert');
const shared = require('../routes/shared');
const sentTg = [];
require('../telegram').botFor = () => ({ isConfigured: () => true, sendMessage: async (id, t, o) => { sentTg.push({ t, o }); } });
let seenAsked = null;
shared._setDeps({ ft: {}, runtime: {
  findTags: (t) => [...String(t).matchAll(/\[([A-Z_]+)(?::([^\]]*))?\]/g)].map((m) => ({ name: m[1], arg: (m[2] || '').trim() })),
  runInjections: async (t, p, o) => { seenAsked = o.asked; return /READ_CALENDAR/.test(t) ? 'READ_CALENDAR:\n - 2 PM dentist' : ''; },
  applyEffects: async (t) => (/ADD_TASK/.test(t) ? { notes: ['task added: call mom'], warnings: [], confirms: [] }
    : /SEND_EMAIL/.test(t) ? { notes: [], warnings: [], confirms: [{ id: 'p1', label: 'Send the email to Bob', detail: 'Subject: hi' }] } : { notes: [], warnings: [], confirms: [] }),
} });
(async () => {
  let r = await shared.runLive('ara', '[READ_CALENDAR]', 'what do I have today');
  assert(/RESULTS:[\s\S]*2 PM dentist/.test(r)); assert.strictEqual(seenAsked, 'what do I have today', 'his words gate the writes');
  r = await shared.runLive('ara', '[ADD_TASK: call mom | ]', 'add call mom');
  assert(/WHAT RAN[\s\S]*✓ task added: call mom/.test(r));
  r = await shared.runLive('ara', '[SEND_EMAIL: bob@x.com | hi | yo]', 'email bob');
  assert(/waiting on his Confirm tap on Telegram: Send the email to Bob/.test(r));
  assert(sentTg.some((m) => /Send the email to Bob\?/.test(m.t) && m.o.reply_markup), 'the Confirm card went to Telegram');
  assert(/No command tag/.test(await shared.runLive('ara', 'just talk', '')));
  console.log('live commands ok');
})().catch((e) => { console.error(e); process.exit(1); });
