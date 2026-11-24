// Worker 59: a worker never shows done for a job that didn't finish; placeholders are
// never typed or handed back; magic links are found; J.A.R.V.I.S.'s inbox hand-offs to A.R.A. pass.
const assert = require('assert');
const Module = require('module');
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './db') return { query: async () => [] };
  if (req === './syncStore') return { getSetting: async (k, f) => f, setSetting: async () => {} };
  return load.call(this, req, parent, ...rest);
};
const w = require('../workers');
const b = require('../browserAgent');
const { codeIn, linkIn } = require('../siteLogins');
const { relayAllowed } = require('../personas');

// worker 57's real result: a "done" that says it was blocked
const blocked = 'Blocked at email verification… No account has been fully created yet… no API key exists.';
assert.strictEqual(w.browseStatus({ status: 'done', text: blocked }), 'needs_you', 'blocked at email verification is waiting, not done');
assert.strictEqual(w.browseStatus({ status: 'done', success: false, text: 'x', reason: 'CAPTCHA' }), 'needs_you');
assert.strictEqual(w.browseStatus({ status: 'done', success: false, text: 'Could not find the page.' }), 'failed');
assert.strictEqual(w.browseStatus({ status: 'done', text: 'No account has been created yet.' }), 'failed');
assert.strictEqual(w.browseStatus({ status: 'done', success: true, text: 'Created the account; key gsk_abc saved.' }), 'done');
assert.strictEqual(w.browseStatus({ status: 'done', text: 'Pricing: Pro $20/mo, Team $40/mo.' }), 'done');
assert.strictEqual(w.browseStatus({ status: 'done', success: true, text: 'The code is {{CODE}}' }), 'failed', 'placeholder result is never done');
assert.strictEqual(w.browseStatus({ status: 'ask', text: 'q' }), 'needs_you');
assert.strictEqual(w.browseStatus({ status: 'stopped', text: 'x' }), 'failed');

// settleResult in the browser module
const s1 = b.settleResult({ status: 'done', success: false, reason: 'blocked at the email screen', text: 'nothing made' });
assert.strictEqual(s1.status, 'failed'); assert.ok(/NOT FINISHED/.test(s1.text));
assert.strictEqual(b.settleResult({ status: 'done', success: true, text: 'ok' }).status, 'done');
assert.strictEqual(b.settleResult({ status: 'done', text: 'Could not sign in.' }).status, 'failed');

// code workers
assert.strictEqual(w.codeStatus({ status: 'done', result: 'FAILED: tests red' }).status, 'failed');
const p = w.codeStatus({ status: 'done', result: 'PARTLY DONE: half' });
assert.ok(p.status === 'needs_you' && p.partial);
assert.strictEqual(w.codeStatus({ status: 'done', result: 'DONE: all' }).status, 'done');

// done action carries success
const a = b.parseAction('{"thought":"x","action":{"type":"done","success":false,"result":"blocked","reason":"email check"}}');
assert.strictEqual(b.doneSuccess(a), false); assert.strictEqual(a.reason, 'email check');
assert.strictEqual(b.doneSuccess(b.parseAction('{"action":{"type":"done","result":"r"}}')), null);

// placeholders: filled when known (any spacing/case), an error (never the literal) when not
assert.strictEqual(b.fillSecrets('{{CODE}}', { CODE: '123456' }), '123456');
assert.strictEqual(b.fillSecrets('{{ code }}', { CODE: '123456' }), '123456');
assert.strictEqual(b.fillSecrets('{{LINK}}', { LINK: 'https://x.io/v?t=1' }), 'https://x.io/v?t=1');
assert.throws(() => b.fillSecrets('{{INFO}}', {}), /no value for \{\{INFO\}\}/);
assert.throws(() => b.fillSecrets('{{CODE}}', { CODE: '' }), /no value/);
assert.strictEqual(b.fillSecrets('plain', {}), 'plain');
// goto {{LINK}} parses (not rejected as a non-URL, not mangled against the page URL)
const g = b.parseAction('{"action":{"type":"goto","url":"{{LINK}}"}}', 'https://groq.com/x');
assert.ok(!g.error && g.url === '{{LINK}}', JSON.stringify(g));

// codes and magic links
assert.strictEqual(codeIn('Your code is 482913.'), '482913');
assert.strictEqual(linkIn('Sign in: https://console.groq.com/auth/verify?token=abc123. Unsub https://x.com/unsubscribe'), 'https://console.groq.com/auth/verify?token=abc123');
assert.strictEqual(linkIn('see https://example.com/blog'), null);

// emailedCode: waits, finds a link when there is no code, null (not a placeholder) when nothing
(async () => {
  const google = require('../google');
  const orig = { l: google.gmailList, r: google.gmailRead };
  let polls = 0;
  google.gmailList = async () => { polls++; return polls < 3 ? '' : '[id:m1] Groq'; };
  google.gmailRead = async () => 'h1\nh2\nh3\nh4\nClick https://console.groq.com/magic-link?t=zz to sign in';
  const got = await b.emailedCode({ wait: 1000, pollMs: 10 });
  assert.deepStrictEqual(got, { link: 'https://console.groq.com/magic-link?t=zz' });
  google.gmailList = async () => '';
  assert.strictEqual(await b.emailedCode({ wait: 50, pollMs: 10 }), null);
  google.gmailList = orig.l; google.gmailRead = orig.r;
  assert.ok(/EMAIL_CODE_WAIT_MS\) \|\| 10 \* 60e3/.test(require('fs').readFileSync(require.resolve('../browserAgent'), 'utf8')), '10 minute wait');

  // hand-offs: J.A.R.V.I.S. -> A.R.A. for an emailed code/link passes with no message of his naming it
  assert.ok(relayAllowed('', 'ara', 'jarvis', 'Groq emailed a sign-in code, please fetch it from his inbox'));
  assert.ok(relayAllowed('yes', 'ara', 'jarvis', 'Need the magic link from his email'));
  assert.ok(!relayAllowed('', 'ara', 'jarvis', 'How is the weather in Paris'));
  assert.ok(!relayAllowed('', 'ara', 'sage', 'check his inbox'), 'only J.A.R.V.I.S.');
  console.log('worker honesty: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
