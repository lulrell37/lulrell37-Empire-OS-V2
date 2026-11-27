// node server/scripts/test-cron-claims.js — each scheduled slot runs once (server/cronClaims.js).
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { claimSlot, _setDb } = require('../cronClaims');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await db.query(sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS cron_claims')));
  const now = Date.parse('2026-11-27T15:00:05Z');
  await db.query("DELETE FROM cron_claims WHERE key LIKE 'zz_test%'");
  try {
    assert.strictEqual(await claimSlot('zz_test|0,30 8-21 * * *', now), true, 'first run claims the slot');
    assert.strictEqual(await claimSlot('zz_test|0,30 8-21 * * *', now + 20000), false, 'a second run in the same minute is refused');
    assert.strictEqual(await claimSlot('zz_test|*/15', now), true, 'a different timer at the same minute runs');
    assert.strictEqual(await claimSlot('zz_test|0,30 8-21 * * *', now + 30 * 60000), true, 'the next slot runs');
    // Database down: skip, never run blind.
    _setDb({ query: async () => { throw new Error('timeout'); } });
    assert.strictEqual(await claimSlot('zz_test|x', now), false);
    _setDb(null);
    console.log('cron claims ok');
  } finally { await db.query("DELETE FROM cron_claims WHERE key LIKE 'zz_test%'").catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
