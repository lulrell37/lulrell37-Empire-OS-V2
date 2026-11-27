// node server/scripts/test-app-passoffs.js — A.R.A. in the app sees what she passed on
// (routes/shared.js `passoffs`, owner 2026-11-27).
const assert = require('assert');
const chat = require('../routes/chat');
const now = Date.now();
const rows = [
  { id: 1, persona: 'ara', role: 'user', content: 'hey', ts: now - 3600e3 },
  { id: 2, persona: 'ara', role: 'assistant', content: '[SENT ON YOUR OWN, Thu 3:36 PM ET — not a reply to him]\n🔻 **T.A.L.O.N. closed SELL Gold (XAUUSD) (swing)** — a loss. Entry 3568.11 → Exit 7188.24', ts: now - 2 * 3600e3 },
  { id: 3, persona: 'ara', role: 'assistant', content: '[SENT ON YOUR OWN, Fri 10:08 AM ET — not a reply to him]\n⚖️ **A.I.S.H.A. → A.R.A. — the politics, made simple**, Mr. Burrus. Senate shutdown vote failed.', ts: now - 600e3 },
  { id: 4, persona: 'ara', role: 'assistant', content: '[SENT ON YOUR OWN, Mon — not a reply to him]\nold one from days ago', ts: now - 5 * 86400e3 },
];
chat._test.setDb({ query: async (sql, p) => ({ rows: rows.filter((r) => r.persona === p[0]).sort((a, b) => b.ts - a.ts).slice(0, p[1]) }) });
const shared = require('../routes/shared');
shared._setDeps({ runtime: { newsBlock: async () => '' }, ft: {} });
(async () => {
  const block = await shared.context('ara', '');
  assert(/PASS-OFFS — what you passed on to him from the team/.test(block));
  assert(/Exit 7188\.24/.test(block) && /Senate shutdown vote failed/.test(block), 'both pass-offs, numbers kept');
  assert(block.indexOf('7188') < block.indexOf('Senate'), 'oldest first');
  assert(!/old one from days ago/.test(block), 'only the last 36 hours');
  assert(!/\bhey\b/.test(block), 'the chat itself is not repeated');
  assert(/from Talon/.test(block) || /T\.A\.L\.O\.N\./.test(block));
  const none = await shared.context('jarvis', '');
  assert(!/PASS-OFFS/.test(none), 'nothing passed on, nothing added');
  console.log('app pass-offs ok');
})().catch((e) => { console.error(e); process.exit(1); });
