// node server/scripts/test-relay-promises.js — a reply that says it's handing
// something to another persona ("Relaying the fix to Atlas now") with no
// [RELAY_TO] behind it is caught (promisedHandoffs), and the app's copy matches.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { promisedHandoffs, handoffNames } = require('../personas');
const N = handoffNames();
const owed = (t, self = 'ara') => promisedHandoffs(t, N, self);

assert.deepStrictEqual(owed('Got it — my bad on the $165K, that was pulled from the memory block and it was wrong. Correcting to $165 today.\n\nRelaying the fix to Atlas now.'), ['atlas'], 'his example');
assert.deepStrictEqual(owed("I'll pass this to A.T.L.A.S. right away."), ['atlas'], 'dotted name');
assert.deepStrictEqual(owed('Let ATLAS know.'), ['atlas'], 'all caps');
assert.deepStrictEqual(owed("I'm handing this to T.A.L.O.N. so he can close it."), ['talon']);
assert.deepStrictEqual(owed('Sending S.E.L.E.N.E. the brief now.'), ['selene']);
assert.deepStrictEqual(owed('Atlas says you made $165 today.'), [], 'a report, not a hand-off');
assert.deepStrictEqual(owed('Want me to ask Talon?'), [], 'an offer');
assert.deepStrictEqual(owed('No need to tell Talon.'), [], 'a negative');
assert.deepStrictEqual(owed('I picked up a pen and a hook to send off.'), [], 'lowercase words are not names');
assert.deepStrictEqual(owed('I will tell Ara.', 'ara'), [], 'not herself');

// False positives (2026-11-26, J.A.R.V.I.S.): naming a persona is not promising a hand-off.
assert.deepStrictEqual(owed('The worker handles sign-in end to end, so neither you nor A.R.A. has to touch it.', 'jarvis'), [], 'neither/nor');
assert.deepStrictEqual(owed('Fixes planned:\n1. Wait cap on idle pages\n2. Steps A.R.A. could handle: a browser worker that stops at one of those should go to her.', 'jarvis'), [], 'list item, hypothetical');
assert.deepStrictEqual(owed('It goes to A.R.A. when the code arrives.', 'jarvis'), [], 'third person');
assert.deepStrictEqual(owed('I told Atlas yesterday and he sent it back.'), [], 'past');
assert.deepStrictEqual(owed('Talon could pass this to Atlas if needed.', 'jarvis'), [], 'hypothetical');
assert.deepStrictEqual(owed('I will do it without telling Atlas.'), [], 'without');
assert.deepStrictEqual(owed('Atlas and Talon both read the brief.'), [], 'bare names');
assert.deepStrictEqual(owed('The email comes from A.R.A., so she has it.', 'jarvis'), [], 'comes from');
assert.deepStrictEqual(owed('I sent Atlas the numbers earlier.'), [], 'past sent');
// Real promises still caught.
assert.deepStrictEqual(owed("I'll ask Talon to close it.", 'jarvis'), ['talon']);
assert.deepStrictEqual(owed('Let me check with Atlas on that.', 'jarvis'), ['atlas']);
assert.deepStrictEqual(owed("I'm sending it to S.C.R.I.B.E. now.", 'jarvis'), ['scribe']);
assert.deepStrictEqual(owed('Passing this to A.R.A. so she can email him.', 'jarvis'), ['ara']);

const norm = (s) => s.replace(/\s+/g, '');
const body = (src) => { const a = src.indexOf('const HANDOFF_VERB'); const b = src.indexOf('return [...out];', a); return norm(src.slice(a, b)).replace(/exportfunction/g, 'function'); };
const server = fs.readFileSync(path.join(__dirname, '..', 'personas.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'personas', 'personas.js'), 'utf8');
assert.strictEqual(body(app), body(server), 'src/personas/personas.js promisedHandoffs drifted from the server copy');
console.log('relay promises: all checks passed');
