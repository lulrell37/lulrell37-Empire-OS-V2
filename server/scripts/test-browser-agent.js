// node server/scripts/test-browser-agent.js — the browser agent's guard rails and
// step parsing (no browser is launched).
const assert = require('assert');
const B = require('../browserAgent');

assert.strictEqual(B.parseAction('{"thought":"x","action":{"type":"click","id":3}}').type, 'click');
assert.ok(B.parseAction('{"action":{"type":"goto","url":"linkedin.com"}}').error, 'goto needs a full URL');
assert.ok(B.parseAction('{"action":{"type":"type","id":2}}').error, 'type needs text');
assert.ok(B.parseAction('no json').error);
assert.strictEqual(B.parseAction('{"action":{"type":"done","result":"found it"}}').type, 'done');

// World-changing clicks stop for his OK; reading and moving around don't.
for (const t of ['Send', 'Connect', 'Post', 'Place order', 'Confirm', 'Delete', 'Apply']) assert.ok(B.isCommit({ type: 'click' }, { text: t, tag: 'button' }), t);
for (const t of ['Search', 'Show more results', 'Next', 'Close', 'See all']) assert.ok(!B.isCommit({ type: 'click' }, { text: t, tag: 'button' }), t);
assert.ok(!B.isCommit({ type: 'press', key: 'Enter' }, { tag: 'input', type: 'search', text: 'Search' }), 'Enter in a search box is a search');
assert.ok(B.isCommit({ type: 'press', key: 'Enter' }, { tag: 'textarea', type: '', text: 'Write a message' }), 'Enter in a message box may send');

assert.ok(B.approves('yes, send it'));
assert.ok(!B.approves('no, hold off'));
assert.ok(!B.approves('what is it about to send?'));

// J.A.R.V.I.S. and A.R.A. only.
assert.deepStrictEqual([...B.BROWSE_PERSONAS].sort(), ['ara', 'jarvis']);
(async () => {
  await assert.rejects(B.browseTag('talon', 'look up gold'), /J\.A\.R\.V\.I\.S\..*A\.R\.A\./);
  console.log('browser agent: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
