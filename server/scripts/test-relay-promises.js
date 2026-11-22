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

const norm = (s) => s.replace(/\s+/g, '');
const body = (src) => { const a = src.indexOf('const HANDOFF_VERB'); const b = src.indexOf('return [...out];', a); return norm(src.slice(a, b)).replace(/exportfunction/g, 'function'); };
const server = fs.readFileSync(path.join(__dirname, '..', 'personas.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'personas', 'personas.js'), 'utf8');
assert.strictEqual(body(app), body(server), 'src/personas/personas.js promisedHandoffs drifted from the server copy');
console.log('relay promises: all checks passed');
