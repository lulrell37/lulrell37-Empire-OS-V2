// node server/scripts/test-site-logins.js — browser logins for the downloads:
// cookies out of Chrome, and which cookies.txt a download uses (no browser).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.EMPIRE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'logins-'));
const L = require('../siteLogins');
const C = require('../clipScan');

const ck = [
  { domain: '.youtube.com', path: '/', secure: true, expires: 1900000000.5, name: 'SID', value: 'a' },
  { domain: 'accounts.google.com', path: '/', secure: true, expires: -1, name: 'LSID', value: 'b' },
  { domain: '.instagram.com', path: '/', secure: true, expires: 1900000000, name: 'sessionid', value: 'c' },
  { domain: 'evil-youtube.com', path: '/', secure: false, expires: 0, name: 'x', value: 'y' },
];
const yt = L.toNetscape(ck, L.SITES.youtube.domains);
assert.ok(yt.startsWith('# Netscape HTTP Cookie File'));
assert.ok(yt.includes('.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\ta'));
assert.ok(yt.includes('accounts.google.com\tFALSE\t/\tTRUE\t0\tLSID\tb'));
assert.ok(!yt.includes('sessionid') && !yt.includes('evil'), 'only this site');
assert.ok(L.toNetscape(ck, L.SITES.instagram.domains).includes('sessionid'));
assert.strictEqual(L.toNetscape([], L.SITES.youtube.domains), '');

delete process.env.YOUTUBE_COOKIES; delete process.env.YOUTUBE_COOKIES_FILE;
assert.deepStrictEqual(C.cookieArgs('https://www.youtube.com/watch?v=KAgxDihEu4M'), [], 'nothing yet');
fs.mkdirSync(path.join(process.env.EMPIRE_BIN, 'cookies'), { recursive: true });
const f = path.join(process.env.EMPIRE_BIN, 'cookies', 'youtube.txt');
fs.writeFileSync(f, yt);
assert.deepStrictEqual(C.cookieArgs('https://www.youtube.com/watch?v=KAgxDihEu4M'), ['--cookies', f], 'the browser login');
process.env.YOUTUBE_COOKIES_FILE = '/tmp/his.txt';
assert.deepStrictEqual(C.cookieArgs('https://youtu.be/KAgxDihEu4M'), ['--cookies', '/tmp/his.txt'], 'his own cookies.txt wins');
delete process.env.YOUTUBE_COOKIES_FILE;
assert.deepStrictEqual(C.cookieArgs('https://www.instagram.com/reel/abc/'), [], 'no Instagram login yet');

assert.strictEqual(L.hasAccount('youtube'), false);
process.env.YOUTUBE_LOGIN_EMAIL = 'x@gmail.com'; process.env.YOUTUBE_LOGIN_PASSWORD = 'p';
assert.strictEqual(L.hasAccount('youtube'), true);
for (const t of ['Allow all cookies', 'Accept all', 'Not now', 'Save info', 'Continue']) assert.ok(L.ALLOW.test(t), t);
for (const t of ['Delete account', 'Post', 'Follow']) assert.ok(!L.ALLOW.test(t), t);
assert.ok(/\{\{PASSWORD\}\}/.test(L.SITES.youtube.task) && !/x@gmail/.test(L.SITES.youtube.task), 'the brain never sees the password');
(async () => {
  delete process.env.YOUTUBE_LOGIN_PASSWORD;
  assert.strictEqual(await L.ensureLogin('youtube'), false, 'no account: no sign-in attempt, no message');
  console.log('site logins: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
