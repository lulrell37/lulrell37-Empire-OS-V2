// node server/scripts/test-recall-days.js — which days a recall question names,
// so [MEMORY_QUERY] can read that day's full conversation.
const assert = require('assert');
const { recallDays } = require('../personaRuntime');
const now = Date.parse('2026-11-21T12:44:00Z'); // Sat Nov 21, 7:44 AM ET
assert.deepStrictEqual(recallDays('What did we discuss on Tuesday, November 17, 2026', now), ['2026-11-17']);
assert.deepStrictEqual(recallDays('what did we talk about on november 17th', now), ['2026-11-17']);
assert.deepStrictEqual(recallDays('Nov 3 and 2026-11-05', now), ['2026-11-03', '2026-11-05']);
assert.deepStrictEqual(recallDays('what happened on December 2', now), ['2025-12-02'], 'no year, in the future -> last year');
assert.deepStrictEqual(recallDays('what did I say yesterday', now), ['2026-11-20']);
assert.deepStrictEqual(recallDays('when did I pick the hoodie supplier', now), []);
assert.deepStrictEqual(recallDays('may I ask about the march plan', now), [], 'month words with no day');
console.log('recall days: all checks passed');
