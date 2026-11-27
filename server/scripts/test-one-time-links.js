// node server/scripts/test-one-time-links.js — a one-time sign-in link is opened once,
// redirects are waited out, a spent link sends the brain back for a new one, and the
// email search never hands back a link already opened (owner, 2026-11-27).
const assert = require('assert');
const ba = require('../browserAgent');
const L = require('../emailLinks');
const stytch = 'https://stytch.com/v1/magic_links/redirect?public_token=x&token=8YQ_abc';
assert(ba.oneTimeLink(stytch));
assert(ba.oneTimeLink('https://example.com/verify?code=123'));
assert(!ba.oneTimeLink('https://console.groq.com/keys'));
assert(ba.SPENT.test('https://stytch.com/redirect-error'));
assert(ba.SPENT.test('This link has expired. Please request a new one.'));
assert(!ba.SPENT.test('Welcome to GroqCloud'));

(async () => {
  // The email search skips a spent link and waits for the newer email.
  ba.SPENT_LINKS.set(stytch, Date.now());
  let polls = 0;
  const inbox = [{ id: 'old', urls: [{ text: 'Log in to Groq', url: stytch }], text: 'Sign in to Groq', internalDate: Date.now() }];
  const deps = { list: async () => { polls++; if (polls === 3) inbox.unshift({ id: 'new', urls: [{ text: 'Log in to Groq', url: 'https://stytch.com/v1/magic_links/redirect?token=FRESH' }], text: 'Sign in to Groq', internalDate: Date.now() }); return inbox.map((m) => m.id); },
    read: async (id) => inbox.find((m) => m.id === id) };
  const got = await L.waitForEmailAuth({ since: Date.now() - 60000, sender: 'groq', deps, exclude: ba.spent, pollMs: 1, timeoutMs: 5000, sleep: async () => {} });
  assert(got.ok && /FRESH/.test(got.url), JSON.stringify(got));
  assert(polls >= 3, 'it waited for the new one instead of returning the spent link');

  // Opening a spent link again is refused before the browser goes anywhere.
  const b = { cdp: { send: async () => { throw new Error('should not navigate'); } }, session: 's' };
  await assert.rejects(() => ba._doAction(b, { type: 'goto', url: stytch }, null, {}), /already opened in this run, so it is spent/);
  console.log('one-time links ok');
})().catch((e) => { console.error(e); process.exit(1); });
