// node server/scripts/test-emailed-link.js — a page that says a sign-in link was emailed is
// detected, the right URL is chosen from a Stytch-style email, emails older than the
// submit time are ignored, and the link goes out as a LINK secret.
const assert = require('assert');
const logins = require('../siteLogins');
const B = require('../browserAgent');
const L = require('../emailLinks');

for (const t of ['Groq sent a magic link to your email — check your email', 'We sent you a link to sign in', 'Click the link in your inbox to continue', 'A verification link was emailed'])
  assert.ok(logins.wantsEmailLink(t), t);
for (const t of ['Pick a plan', 'Enter your password', 'Go to the pricing page']) assert.ok(!logins.wantsEmailLink(t), t);
assert.ok(logins.wantsEmailCode('check your email for the link'), 'existing detection kept');

const body = `Sign in to Groq\n[Log in to Groq](https://stytch.com/v1/magic_links/redirect?public_token=pk&token=tk&stytch_redirect_type=login)\n[Help center](https://help.groq.com/x)\n[Privacy](https://groq.com/privacy)\n[Unsubscribe](https://groq.com/unsubscribe?u=1)`;
const links = L.extractLinks(body);
assert.match(L.pickAuthLink(links), /stytch\.com\/v1\/magic_links\/redirect\?public_token=pk&token=tk/);
assert.strictEqual(L.pickAuthLink(L.extractLinks('[Help](https://help.groq.com/a) [Unsubscribe](https://groq.com/unsubscribe)')), null);

(async () => {
  const submit = Date.now();
  const mk = (internalDate) => ({ list: async () => ['m1'], read: async () => ({ id: 'm1', from: 'noreply@groq.com', subject: 'Your login request to Groq', text: body, internalDate }) });
  const fast = { sleep: async () => {}, pollMs: 10 };
  // An email from 30 min earlier is never used.
  let t = 0; const now = () => (t += 100);
  const old = await B.emailedLink(submit, 'groq.com', { deps: mk(submit - 30 * 60e3), timeoutMs: 1000, now, ...fast });
  assert.strictEqual(old.ok, false); assert.match(old.text, /10 min|arrive|no/i);
  const fresh = await B.emailedLink(submit, 'groq.com', { deps: mk(submit + 5000), timeoutMs: 1000, now: Date.now, ...fast });
  assert.strictEqual(fresh.ok, true); assert.match(fresh.url, /^https:\/\/stytch\.com\/v1\/magic_links/);
  assert.strictEqual(process.env.EMAIL_LINK_WAIT_MS, undefined);
  console.log('emailed link: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
