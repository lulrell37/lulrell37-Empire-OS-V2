// node server/scripts/test-shared-logins.js — every browser shares one set of
// logins: cookies saved after a task in one browser are loaded into the next one
// (a fresh worker's included), merged by name/domain/path, expired ones dropped.
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jar-'));
process.env.BROWSER_PROFILES = dir;
const B = require('../browserAgent');
const fakeCdp = (cookies) => ({ set: null, send: async (m, p) => { if (m === 'Storage.getCookies') return { cookies }; if (m === 'Storage.setCookies') { fakeCdp.last = p.cookies; return {}; } } });
(async () => {
  const future = Date.now() / 1000 + 86400, past = Date.now() / 1000 - 10;
  // J.A.R.V.I.S.'s browser is signed in to Google; save after his task.
  await B.saveJar({ cdp: fakeCdp([{ name: 'SID', value: 'g1', domain: '.google.com', path: '/', secure: true, httpOnly: true, expires: future }, { name: 'old', value: 'x', domain: '.a.com', path: '/', expires: past }]) });
  // A.R.A.'s browser adds Canva; Google's cookie is refreshed.
  await B.saveJar({ cdp: fakeCdp([{ name: 'SID', value: 'g2', domain: '.google.com', path: '/', expires: future }, { name: 'canva', value: 'c', domain: '.canva.com', path: '/', expires: future }]) });
  const jar = B.readJar();
  assert.deepStrictEqual(jar.map((c) => `${c.name}=${c.value}`).sort(), ['SID=g2', 'canva=c'], 'merged, newest wins, expired dropped');
  assert.strictEqual((fs.statSync(path.join(dir, 'shared-cookies.json')).mode & 0o777), 0o600, 'private file');
  // A fresh worker's browser starts with both logins.
  const cdp = fakeCdp([]);
  assert.strictEqual(await B.loadJar(cdp), 2);
  assert.deepStrictEqual(fakeCdp.last.map((c) => c.domain).sort(), ['.canva.com', '.google.com']);
  console.log('shared logins: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
