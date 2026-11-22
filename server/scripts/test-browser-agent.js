// node server/scripts/test-browser-agent.js — the browser agent's guard rails and
// step parsing (no browser is launched).
const assert = require('assert');
const B = require('../browserAgent');

assert.strictEqual(B.parseAction('{"thought":"x","action":{"type":"click","id":3}}').type, 'click');
assert.ok(B.parseAction('{"action":{"type":"goto","url":"linkedin.com"}}').error, 'goto needs a full URL');
assert.ok(B.parseAction('{"action":{"type":"type","id":2}}').error, 'type needs text');
assert.strictEqual(B.parseAction('{"thought":"x","action":"scroll"}').type, 'scroll', 'flat action string');
assert.strictEqual(B.parseAction('{"action":"click","id":7}').id, 7, 'flat click');
assert.strictEqual(B.parseAction('{"action":{"action":"press","key":"PageDown"}}').key, 'PageDown', 'nested action key');
assert.ok(B.parseAction('no json').error);
assert.strictEqual(B.parseAction('{"action":{"type":"done","result":"found it"}}').type, 'done');

// World-changing clicks stop for his OK; reading and moving around don't.
for (const t of ['Send', 'Connect', 'Post', 'Place order', 'Confirm', 'Delete', 'Apply']) assert.ok(B.isCommit({ type: 'click' }, { text: t, tag: 'button' }), t);
for (const t of ['Search', 'Show more results', 'Next', 'Close', 'See all']) assert.ok(!B.isCommit({ type: 'click' }, { text: t, tag: 'button' }), t);
for (const t of ['Sign up with email', 'Create account', 'Register']) assert.ok(!B.isCommit({ type: 'click' }, { text: t, tag: 'button' }), t + ' is his standing order');
for (const t of ['Accept all cookies', 'Accept all', 'Got it']) assert.ok(/./.test(t));
assert.ok(!B.isCommit({ type: 'press', key: 'Enter' }, { tag: 'input', type: 'search', text: 'Search' }), 'Enter in a search box is a search');
assert.ok(B.isCommit({ type: 'press', key: 'Enter' }, { tag: 'textarea', type: '', text: 'Write a message' }), 'Enter in a message box may send');

assert.ok(B.approves('yes, send it'));
assert.ok(!B.approves('no, hold off'));
assert.ok(!B.approves('what is it about to send?'));

// J.A.R.V.I.S. and A.R.A. only.
assert.deepStrictEqual([...B.BROWSE_PERSONAS].sort(), ['ara', 'jarvis']);
// A worker's plan: stated on the first reply, the plan step on every reply.
const pa = B.parseAction('{"thought":"x","plan":["Open Canva","Read pages"," "],"planStep":1,"action":{"type":"goto","url":"https://canva.com"}}');
assert.deepStrictEqual(pa.plan, ['Open Canva', 'Read pages']); assert.strictEqual(pa.planStep, 1); assert.strictEqual(pa.type, 'goto');
assert.strictEqual(B.parseAction('{"action":"scroll","planStep":"2"}').planStep, 2, 'flat form keeps planStep');
assert.strictEqual(B.parseAction('{"action":"scroll"}').plan, null);
assert.ok(/"planStep"/.test(B.AGENT_SYSTEM('J', true)) && !/planStep/.test(B.AGENT_SYSTEM('J')), 'only a worker\'s run is asked for a plan');
const seen = []; const pt = B.planTracker((n, at) => seen.push([n.length, at]));
assert.strictEqual(pt.prompt(), '');
pt.note({ type: 'goto' }); assert.strictEqual(seen.length, 0, 'no plan, nothing to report');
pt.note({ plan: ['a', 'b', 'c', 'd'] }); pt.note({ planStep: 1 }); pt.note({ planStep: 3 }); pt.note({ planStep: 9 });
assert.deepStrictEqual(seen, [[4, 1], [4, 3], [4, 4]], 'fires on change only, step clamped to the plan');
assert.match(pt.prompt(), /YOUR PLAN \(you're on step 4\):\n1\. a/);
const off = B.planTracker(null); off.note({ plan: ['a'], planStep: 1 }); assert.strictEqual(off.prompt(), '', 'a plain [BROWSE] carries no plan');
const carried = []; B.planTracker((n, at) => carried.push(at), ['a', 'b'], 2).note({ planStep: 2 }); assert.deepStrictEqual(carried, [], 'carried plan + step: no repeat');
(async () => {
  await assert.rejects(B.browseTag('talon', 'look up gold'), /J\.A\.R\.V\.I\.S\..*A\.R\.A\./);
  console.log('browser agent: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
