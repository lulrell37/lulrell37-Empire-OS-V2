// The "agree first" gate on [WORKER_START] (server/workers.js ownerGo / startGate).
const assert = require('assert');
const workers = require('../workers');
const go = [
  'go', 'yes do it', 'Ok go ahead', 'fix it', 'put a worker on it', 'Make me a logo for Empire Digital',
  'build the quiz feature', 'sign me up for groq', 'can you set up the groq account', 'Retry the Groq sign up', 'sounds good',
];
const no = [
  'the groq sign up keeps failing', 'why did the worker fail?', 'Jarvis keeps coming back to me',
  'what do you think is wrong', 'is the server down?', '[SENT ON YOUR OWN, 3:00 PM ET — not a reply to him] x', '',
  '[The server restarted] carry on',
];
for (const t of go) assert.strictEqual(workers.ownerGo(t), true, `should be a go: ${t}`);
for (const t of no) assert.strictEqual(workers.ownerGo(t), false, `should not be a go: ${t}`);

(async () => {
  const rows = [];
  workers._setDeps({ query: async (sql, args) => { rows.push(args); return { rows: [] }; } });
  let g = await workers.startGate('code | Fix the Groq link | do the thing', { asked: 'groq keeps failing', depth: 0 });
  assert.strictEqual(g.run, false);
  assert.ok(/NOT STARTED/.test(g.text));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][2], 'worker_start');
  assert.ok(/Fix the Groq link/.test(rows[0][3]));
  g = await workers.startGate('code | x | y', { asked: 'go', depth: 0 });
  assert.strictEqual(g.run, true);
  g = await workers.startGate('code | x | y', { asked: 'go', depth: 1 });
  assert.strictEqual(g.run, false, 'a relay is never his go');
  console.log('test-worker-gate: ok');
})().catch((e) => { console.error(e); process.exit(1); });

// Only-him stops vs ones the worker settles itself.
{
  const w = require('../workers');
  for (const q of ['Enter the code we texted to your phone number ending 42', 'Approve the sign-in on your phone', 'Add a credit card to continue', 'Should I submit the order?'])
    assert.strictEqual(w.onlyHim(q), true, q);
  for (const q of ['Which account name should I use?', 'What password should the new account have?', 'Pick a plan: Free or Dev?', 'The page asks for an organization name'])
    assert.strictEqual(w.onlyHim(q), false, q);
  console.log('test-worker-gate: only-him ok');
}
