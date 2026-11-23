// Every persona's relay to the lane owner goes through; the limits and the two copies stay in sync.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { relayAllowed } = require('../personas');

// his example: a new YouTube channel, no persona named
const said = 'I decided to start new YouTube channels to make money';
assert.ok(relayAllowed(said, 'sage', 'jarvis'), 'S.A.G.E. gets the research');
assert.ok(relayAllowed(said, 'atlas', 'sage'), 'A.T.L.A.S. gets the numbers');
// a relay from J.A.R.V.I.S. to R.O.G.U.E. about clips, his message names nobody
assert.ok(!relayAllowed('how is it going', 'rogue', 'jarvis'), 'no lane, no relay');
assert.ok(relayAllowed('how is it going', 'rogue', 'jarvis', 'cut the clips from that stream'), 'relay text in the owner lane');
assert.ok(relayAllowed('sort out the weekly videos', 'rogue', 'scribe', 'edit the video'), 'lane via relay text');
assert.ok(relayAllowed('is the contract fine', 'aisha', 'atlas'), 'legal goes to A.I.S.H.A.');
// opinions outside any lane still stay put
assert.ok(!relayAllowed('what do you think about the weather', 'talon', 'atlas'), 'no lane match stays blocked');
assert.ok(!relayAllowed('', 'atlas', 'jarvis'));
assert.ok(relayAllowed('anything', 'atlas', 'ara'), 'A.R.A. always');

// limits are in code, unchanged
const rt = fs.readFileSync(path.join(__dirname, '..', 'personaRuntime.js'), 'utf8');
assert.ok(/MAX_RELAY_DEPTH = 3/.test(rt) && /chain\.includes\(id\)/.test(rt), 'depth + chain limits');
assert.ok(/relayAllowed\(asked, id, persona, msg\)/.test(rt), 'gate gets the relay text');

// copies in sync
const norm = (s) => s.replace(/\s+/g, '');
const grab = (src, from, to) => { const a = src.indexOf(from); return norm(src.slice(a, src.indexOf(to, a))); };
const server = fs.readFileSync(path.join(__dirname, '..', 'personas.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'personas', 'personas.js'), 'utf8');
assert.strictEqual(grab(app, 'const LANES', 'export function relayAllowed'), grab(server, 'const LANES', 'function relayAllowed'), 'LANES drifted');

// ADD_BUSINESS exists server + app, and the venture rule is pinned
assert.ok(/case 'ADD_BUSINESS'/.test(fs.readFileSync(path.join(__dirname, '..', 'personaTools.js'), 'utf8')));
assert.ok(/ADD_BUSINESS/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'commandHandler.js'), 'utf8')));
assert.ok(require('../ownerProfile').PINNED.some((l) => /works in unison/.test(l)), 'pinned');
console.log('relay lanes: all checks passed');
