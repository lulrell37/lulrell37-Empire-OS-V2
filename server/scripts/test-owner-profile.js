// node server/scripts/test-owner-profile.js — the profile's output rules (no AI, no DB).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../ownerProfile');
const pin = P.PINNED.join('\n');
const unpin = (t) => t.split('\n').filter((l) => !P.PINNED.includes(l)).join('\n');

// Tags: untagged → all, unknown ids dropped, ids kept, 2024 dates fixed.
assert.strictEqual(P.cleanLine('- Keep replies short'), '- [all] Keep replies short');
assert.strictEqual(P.cleanLine('- [talon] Trade Nasdaq 2024-11-20'), '- [talon] Trade Nasdaq 2026-11-20');
assert.strictEqual(P.cleanLine('- [atlas, A.R.A., bogus] Daily totals'), '- [atlas, ara] Daily totals');
assert.strictEqual(P.cleanLine('- [bogus] x'), '- [all] x');
assert.strictEqual(unpin(P.normalize('Profile:\n- [all] Wants tasks done, not explained (2026-11-20)\nnotes\n-   Keep replies short')), '- [all] Wants tasks done, not explained (2026-11-20)\n- [all] Keep replies short');
assert.strictEqual(P.normalize('nothing'), pin, 'pinned orders always there');
assert.strictEqual(P.normalize('- [jarvis] x\nREMOVED: ' + P.PINNED[0]), pin + '\n- [jarvis] x', 'a pinned order cannot be removed');
assert.ok(P.PINNED.every((l) => P.cleanLine(l) === l && /\[all\]/.test(l)), 'pinned lines are clean and go to everyone');

// No rotation: 50 lines stay 50, and a line the model leaves out stays unless REMOVED.
const many = Array.from({ length: 50 }, (_, i) => `- [all] line ${i}`).join('\n');
assert.strictEqual(unpin(P.normalize(many + '\n' + Array.from({ length: 250 }, (_, i) => `- [all] more ${i}`).join('\n'))).split('\n').length, 300, 'no cap at all');
const prev = '- [all] Wait for push\n- [talon] Old rule\n- Untagged old line';
const next = P.normalize('- [all] Wait for push\n- [talon] New rule\n- [jarvis] Untagged old line\nREMOVED: - [talon] Old rule', prev);
assert.deepStrictEqual(unpin(next).split('\n'), ['- [all] Wait for push', '- [talon] New rule', '- [jarvis] Untagged old line'], 'kept, removed, retagged without duplicates');
assert.ok(P.normalize('- [all] Something new', prev).includes('Wait for push'), 'silently dropped line survives');

// Who sees what.
const prof = '- [all] Core\n- [talon] Trades\n- [atlas, ara] Money\n- Untagged';
assert.strictEqual(P.linesFor(prof, 'talon'), '- Core\n- Trades\n- Untagged');
assert.strictEqual(P.linesFor(prof, 'atlas'), '- Core\n- Money\n- Untagged');
assert.strictEqual(P.linesFor(prof, 'haven'), '- Core\n- Untagged');
assert.strictEqual(P.linesFor(prof, 'ara'), prof);
assert.strictEqual(P.linesFor(prof, 'jarvis'), prof);

// The app's copy (profileFor in src/services/aiService.js) gives the same answers.
const src = fs.readFileSync(path.join(__dirname, '../../src/services/aiService.js'), 'utf8');
const fn = /function profileFor\(profile,id\)\{[\s\S]*?\n\}/.exec(src);
assert.ok(fn, 'profileFor found in the app');
const profileFor = new Function(`${fn[0]}; return profileFor;`)();
for (const id of ['talon', 'atlas', 'haven', 'ara', 'jarvis', 'rogue']) assert.strictEqual(profileFor(prof, id), P.linesFor(prof, id), `app copy drifted for ${id}`);
assert.deepStrictEqual([...P.SEES_ALL].sort(), ['ara', 'jarvis'], 'SEES_ALL changed: update profileFor in the app too');

console.log('owner profile: all checks passed');
