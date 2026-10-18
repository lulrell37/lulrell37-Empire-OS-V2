const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// Replit / Neon-backed Postgres needs SSL; a plain local socket does not.
const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) || process.env.PGSSL === 'disable';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 10,
});

pool.on('error', (e) => console.error('pg pool error', e.message));

async function init() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Postgres rejects NUL in text ("invalid byte sequence for encoding UTF8: 0x00")
// and the \u0000 escape in jsonb. Scraped pages, email bodies and Drive files
// sometimes carry one, so strip it from every param on the way in.
const NUL = /\u0000|\\u0000/g;
function clean(v) {
  if (typeof v === 'string') return v.replace(NUL, '');
  if (v == null || Buffer.isBuffer(v) || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(clean);
  if (typeof v === 'object') {
    if (typeof v.toPostgres === 'function') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[clean(k)] = clean(x);
    return out;
  }
  return v;
}

const query = (text, params) => pool.query(text, params && params.map(clean));

module.exports = { pool, query, init };
