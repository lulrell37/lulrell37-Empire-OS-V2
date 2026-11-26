// His follow-through rules (server/followThrough.js).
const assert = require('assert');
const ft = require('../followThrough');

const promises = [
  "Let me check the calendar for that.", "I'll look into it and get back to you.", "Give me a minute, sir.",
  "I'll find out what happened with the Groq account.", "Checking now.", "I'm going to dig into the logs.",
  "On it — I'll report back shortly.",
];
const notPromises = [
  "Want me to check the logs?", "If you'd like, I can look into it.", "I checked the calendar: the party is at 7 PM.",
  "Should I look into the other account?", "Worker 2 is on it; its report comes to you by itself.", "Here's what I found.",
];
for (const t of promises) assert.ok(ft.promisedCheck(t), `promise: ${t}`);
for (const t of notPromises) assert.strictEqual(ft.promisedCheck(t), '', `not a promise: ${t}`);

const asks = [
  "Can you send me the logo file?", "What's your email for the Groq account?", "Could you share the login?",
  "Once you send the link I'll finish it.", "I just need you to forward that email.",
];
const fine = [
  "Enter the code we texted to your phone number ending 42 — can you send me that code?",
  "Which one do you prefer, the blue or the black?", "Should I go ahead and send it?", "Here's the logo.",
  "Can you approve the sign-in on your phone?",
];
for (const t of asks) assert.ok(ft.asksOwner(t), `asks him: ${t}`);
for (const t of fine) assert.strictEqual(ft.asksOwner(t), '', `fair to ask him: ${t}`);

(async () => {
  // A follow-up is sent by itself, once, and never from a follow-up.
  const sent = [];
  const run = async (p, m) => { sent.push([p, m]); };
  assert.ok(ft.scheduleFollowUp('ara', "Let me check the calendar.", 'when is the party?', { run, delayMs: 10 }));
  assert.strictEqual(ft.scheduleFollowUp('ara', "Let me check the calendar.", 'when is the party?', { run, delayMs: 10 }), false, 'no duplicate');
  assert.strictEqual(ft.scheduleFollowUp('ara', 'x', `${ft.FOLLOW_PREFIX}. ...`, { run, delayMs: 10 }), false, 'no loop');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][0], 'ara');
  assert.ok(sent[0][1].startsWith('[SENT ON YOUR OWN'), 'not treated as his message');
  assert.match(sent[0][1], /when is the party/);
  console.log('follow through: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
