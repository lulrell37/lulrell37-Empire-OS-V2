// node server/scripts/test-open-threads.js — the Open Threads list's output rules (no AI, no DB).
const assert = require('assert');
const T = require('../openThreads');
assert.strictEqual(T.normalize('NONE'), '');
assert.strictEqual(T.normalize('Here you go:\n- **Fiverr** — gig copy drafted · Next step: sign up · Last touched: Nov 20\nthanks'), '- **Fiverr** — gig copy drafted · Next step: sign up · Last touched: Nov 20');
assert.ok(/\[OPEN_THREADS\]/.test(T.OPEN_THREADS_TOOLS));
console.log('open threads: all checks passed');
