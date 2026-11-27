// node server/scripts/test-passoff-memory.js — whatever A.R.A. passes on goes into her
// memory and the sender's, labeled (owner, 2026-11-27).
const assert = require('assert');
const mem = [];
require('../mem0').mem0Remember = (who, text, meta) => { mem.push({ who, text, meta }); };
const { rememberPassed } = require('../talonAlerts');
rememberPassed('talon', '📈 **T.A.L.O.N. just opened a trade** SELL Gold @ 3568.11', {});
assert.deepStrictEqual(mem.map((m) => m.who), ['ara', 'talon']);
assert(/T\.A\.L\.O\.N\.'s message, passed on by you \(A\.R\.A\.\)/.test(mem[0].text) && /NOT his words/.test(mem[0].text));
assert(/3568\.11/.test(mem[0].text) && !/\*\*/.test(mem[0].text));
assert(/Your message, passed on to Mr\. Burrus through A\.R\.A\./.test(mem[1].text));
mem.length = 0;
rememberPassed(null, 'A note from A.R.A. herself', {});
assert.deepStrictEqual(mem.map((m) => m.who), ['ara']);
assert(/Sent by you \(A\.R\.A\.\) to Mr\. Burrus on your own/.test(mem[0].text));
mem.length = 0;
rememberPassed('aisha', 'Politics breakdown', { remember: true });
assert.deepStrictEqual(mem.map((m) => m.who), ['aisha'], 'already remembered for her: not twice');
console.log('passoff memory ok');
