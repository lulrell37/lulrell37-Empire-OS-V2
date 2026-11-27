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
