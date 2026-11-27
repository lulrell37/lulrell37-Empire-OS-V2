// One run per scheduled slot (index.js `schedule`, T.A.L.O.N.'s 5-min tick): a job
// claims '<name>|<minute>' in cron_claims before it runs. A second server process, or
// one stalled process firing late in the same minute, finds the slot taken; a database
// that doesn't answer means skip, never run blind (2026-11-27: during the crash loop
// S.T.E.P.H.A.N.I.E. sent a fresh set on top of an unanswered one, and alerts repeated).
// node server/scripts/test-cron-claims.js.
let db = null;
const q = (...a) => (db || require('./db')).query(...a);

async function claimSlot(name, now = Date.now()) {
  const minute = Math.floor(now / 60000);
  try {
    const { rows } = await q('INSERT INTO cron_claims (key, at) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key', [`${name}|${minute}`, now]);
    if (Math.random() < 0.01) q('DELETE FROM cron_claims WHERE at < $1', [now - 2 * 86400000]).catch(() => {});
    return rows.length > 0;
  } catch (e) {
    console.error(`scheduler failed: ${name} skipped this run, the database didn't answer: ${e.message}`);
    return false;
  }
}

module.exports = { claimSlot, _setDb: (x) => { db = x; } };
