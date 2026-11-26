// node server/scripts/test-email-links.js — emailed links and codes: HTML kept as
// "text (url)", the right link chosen, codes found, the newest email only, and the
// 10-minute no-email path says so plainly.
const assert = require('assert');
const L = require('../emailLinks');

const groq = `<html><head><style>a{color:red}</style></head><body>
<p>Hi,</p><p>Click below to log in to Groq:</p>
<a href="https://console.groq.com/authenticate?token=abc123&amp;x=1" style="padding:8px"><span>Log in to Groq</span></a>
<p>Code ignored: order #123456 on 2026.</p>
<a href="https://click.mailer.com/track/9?u=1">View in browser</a>
<a href="https://groq.com/unsubscribe?u=1">Unsubscribe</a></body></html>`;

(async () => {
  // base64url
  assert.strictEqual(L.decodeB64Url(Buffer.from('héllo ✓??>>', 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'héllo ✓??>>');

  // anchors kept
  const text = L.htmlToText(groq);
  assert.match(text, /Log in to Groq \(https:\/\/console\.groq\.com\/authenticate\?token=abc123&x=1\)/);
  assert.ok(!/<|color:red/.test(text));
  const links = L.extractLinks(text);
  assert.strictEqual(links.length, 3);
  assert.strictEqual(links[0].text, 'Log in to Groq');

  // choosing: the login button, never unsubscribe or tracking
  assert.strictEqual(L.pickAuthLink(links), 'https://console.groq.com/authenticate?token=abc123&x=1');
  assert.strictEqual(L.pickAuthLink([{ text: 'Unsubscribe', url: 'https://x.com/unsubscribe' }, { text: 'View', url: 'https://click.m.com/track/1' }]), null);
  assert.strictEqual(L.pickAuthLink([{ text: '', url: 'https://a.com/verify-email?t=1' }, { text: 'Home', url: 'https://a.com' }]), 'https://a.com/verify-email?t=1');
  assert.strictEqual(L.pickAuthLink([{ text: 'Confirm', url: 'https://a.com/unsubscribe/confirm' }]), null);

  // codes
  assert.strictEqual(L.extractCode('Your verification code is 482913. It expires.'), '482913');
  assert.strictEqual(L.extractCode('Code: 4821'), '4821');
  assert.strictEqual(L.extractCode('Order #123456 in 2026 — see https://a.com/r/778899'), null);
  assert.strictEqual(L.extractCode('Use 73920184 to sign in'), '73920184');
  assert.ok(L.isPlaceholder('{{CODE}}') && L.isPlaceholder(' {{INFO}} ') && !L.isPlaceholder('123456'));

  // waitForEmailAuth: newest only, link then code
  const t0 = 1_000_000_000_000;
  let clock = t0;
  const sleep = async (ms) => { clock += ms; };
  const mk = (over) => ({ id: 'm1', from: 'Groq', subject: 'Your login request to Groq', text: L.htmlToText(groq), urls: L.extractLinks(L.htmlToText(groq)), internalDate: t0 + 5000, ...over });
  let got = await L.waitForEmailAuth({ since: t0, sender: 'groq.com', sleep, now: () => clock, deps: { list: async () => ['m1', 'old'], read: async (id) => (id === 'm1' ? mk() : assert.fail('read an older email')) } });
  assert.ok(got.ok && got.url === 'https://console.groq.com/authenticate?token=abc123&x=1' && !got.code);

  // arrives on the 3rd poll
  let polls = 0;
  got = await L.waitForEmailAuth({ since: t0, sleep, now: () => clock, deps: { list: async () => (++polls < 3 ? [] : ['c1']), read: async () => mk({ id: 'c1', text: 'Your code is 551230', urls: [] }) } });
  assert.ok(got.ok && got.code === '551230' && polls === 3);

  // an email from before the screen is not used
  clock = t0;
  got = await L.waitForEmailAuth({ since: t0, sleep, now: () => clock, deps: { list: async () => ['old'], read: async () => mk({ internalDate: t0 - 3600000 }) } });
  assert.strictEqual(got.ok, false);

  // nothing in 10 minutes: said plainly, polled every 20 s, no placeholder
  clock = t0; polls = 0;
  got = await L.waitForEmailAuth({ since: t0, sleep, now: () => clock, deps: { list: async () => { polls++; return []; }, read: async () => null } });
  assert.strictEqual(got.ok, false);
  assert.match(got.text, /No sign-in code or link arrived in his email within 10 minutes/);
  assert.ok(!/\{\{/.test(got.text));
  assert.ok(polls >= 30 && polls <= 32, `polls ${polls}`);
  assert.ok(clock - t0 <= 10 * 60 * 1000 && clock - t0 >= 9 * 60 * 1000);

  // google.js: an HTML-only Gmail payload keeps its links (this was stripped before)
  const Module = require('module'); const load = Module._load;
  Module._load = function (req, ...r) { return req === './db' || req === 'pg' ? {} : load.call(this, req, ...r); };
  const g = require('../google');
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = g.gmailBodyText({ mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { data: b64('Log in to Groq') } },
    { mimeType: 'text/html', body: { data: b64(groq) } }] });
  assert.match(body, /Log in to Groq \(https:\/\/console\.groq\.com\/authenticate\?token=abc123/);
  const plainOnly = g.gmailBodyText({ mimeType: 'text/plain', body: { data: b64('code 123456') } });
  assert.strictEqual(plainOnly, 'code 123456');
  console.log('email links: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

// A Groq (Stytch) login email: the sign-in link wins over the ZIP code in the footer (2026-11-26).
{
  const L = require('../emailLinks');
  const html = '<p>Click below to log in to Groq.</p><a href="https://console.groq.com/authenticate?token=abc123XYZ">Log in to Groq</a><p>This link expires in 60 minutes.</p><p>Stytch, Inc. 1 Letterman Drive, San Francisco, CA 94129</p>';
  const t = L.htmlToText(html);
  const url = L.pickAuthLink(L.extractLinks(t));
  require('assert').strictEqual(url, 'https://console.groq.com/authenticate?token=abc123XYZ');
  require('assert').strictEqual(L.extractCode(`Your login request to Groq\n${t}`, { strict: true }), null);
  require('assert').strictEqual(L.extractCode('Your verification code is 482913', { strict: true }), '482913');
  (async () => {
    const got = await L.waitForEmailAuth({ sender: 'groq.com', since: 0, timeoutMs: 1, pollMs: 1, deps: { list: async () => ['m1'], read: async () => ({ id: 'm1', subject: 'Your login request to Groq', text: t, internalDate: 1e13 }) } });
    require('assert').strictEqual(got.code, null);
    require('assert').strictEqual(got.url, url);
    console.log('email links: groq/stytch link beats the footer zip');
  })();
}
