// node server/scripts/test-recall.js — the look-before-talking memory block (server/recall.js).
const assert = require('assert');
const { words, recallBlock } = require('../recall');

const w = words('Talon says the gold stop at 4215 got hit, remember the Thanksgiving dinner plan?');
assert(w.includes('thanksgiving') && w.includes('gold') && w.includes('4215'), w);
assert(!w.includes('talon') && !w.includes('remember') && !w.includes('says'), w);

assert.strictEqual(recallBlock({ facts: [], chats: [], recent: [] }, 'ara'), '');
const b = recallBlock({
  facts: [{ who: 'ara', line: '(2026-11-25) He is hosting Thanksgiving' }, { who: 'talon', line: '(2026-11-26) Gold stop at 4215' }],
  chats: [{ role: 'user', content: 'what time is dinner', ts: Date.now() - 864e5 }],
  recent: [],
}, 'ara');
assert(/Never treat something you two already talked about as new/.test(b));
assert(/T\.A\.L\.O\.N\.'s memory\) \(2026-11-26\) Gold stop/.test(b), b);
assert(/Mr\. Burrus: what time is dinner/.test(b));
assert(/never invent a past conversation/.test(b));

// Every path is wired.
const fs = require('fs');
const src = (f) => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
assert(/require\('\.\/recall'\)/.test(src('personaRuntime.js')) && /memoryBlock\(id, /.test(src('personaRuntime.js')), 'relays look at memory');
assert(/require\('\.\/recall'\)/.test(src('personaVoice.js')), 'passed-on messages look at memory');
assert(/briefMemory/.test(src('morningBrief.js')), 'the brief looks at memory');
console.log('recall ok');

// Recall questions keep the old facts that matter when the history is long.
{
  const { factsFor } = require('../personaRuntime');
  const many = Array.from({ length: 3000 }, (_, i) => ({ memory: `filler fact number ${i} about nothing much at all here`, metadata: { date: '2026-11-20' } }));
  many.push({ memory: 'He planned the Atlanta trip for his birthday', metadata: { date: '2026-08-14' } });
  const out = factsFor(many, 'what did we plan in August?', [], 60000);
  assert(out.length <= 61000);
  assert(/Atlanta trip/.test(out), 'an August fact survives when he asks about August');
  assert(/still stored/.test(out));
  const small = factsFor(many.slice(0, 5), 'anything', [], 60000);
  assert(!/left out/.test(small), 'all of it when it fits');
  console.log('recall facts ok');
}
