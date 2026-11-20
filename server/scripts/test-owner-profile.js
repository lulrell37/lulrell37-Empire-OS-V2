// node server/scripts/test-owner-profile.js — the profile's output rules (no AI, no DB).
const assert = require('assert');
const P = require('../ownerProfile');
assert.strictEqual(P.normalize('Profile:\n- Wants tasks done, not explained (2026-11-20)\nnotes\n-   Keep replies short'), '- Wants tasks done, not explained (2026-11-20)\n-   Keep replies short');
assert.strictEqual(P.normalize(Array.from({ length: 50 }, (_, i) => `- line ${i}`).join('\n')).split('\n').length, 35, 'capped');
assert.strictEqual(P.normalize('nothing'), '');
console.log('owner profile: all checks passed');
