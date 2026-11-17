// Can a new commit share an existing node_modules, or does it need `npm ci`?
// Used by boot.js. Sharing is allowed ONLY when both hold:
//   1. the new package.json declares exactly the same dependency sets as the
//      copy we'd borrow from (every dependency field, not just `dependencies`), and
//   2. what is ACTUALLY installed in that node_modules satisfies the new
//      lockfile: every non-dev package in it is present at the locked version.
// (2) matters because the borrowed copy's package.json can be ahead of its
// node_modules (checkout updated, install never re-run) — comparing manifests
// alone then says "unchanged" while the package (e.g. yt-dlp-exec) is missing.
// Anything unreadable or unknown -> not shareable -> npm ci.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Content hash of a file ('' when missing). Raw bytes, so ANY edit to package.json or
// package-lock.json (even one the dependency-field compare below would miss) is a change.
const fileHash = (file) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
};

const FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies', 'overrides'];

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// Key-sorted so ordering never matters; any add/remove/version change does.
const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  : JSON.stringify(v));

function manifestKey(dir) {
  const p = readJson(path.join(dir, 'package.json'));
  if (!p) return null;
  return canon(FIELDS.map((f) => p[f] || {}));
}

// Returns '' when `nodeModulesDir` can be shared with the code in `newDir`, else the reason not.
function shareBlocker(newDir, oldDir) {
  const nm = path.join(oldDir, 'node_modules');
  if (!fs.existsSync(nm)) return 'no node_modules to share';
  // Any byte change to package.json or package-lock.json -> full install, never share.
  for (const f of ['package.json', 'package-lock.json']) {
    if (fileHash(path.join(newDir, f)) !== fileHash(path.join(oldDir, f))) return `${f} changed`;
  }
  const a = manifestKey(newDir);
  const b = manifestKey(oldDir);
  if (a === null || b === null) return 'package.json unreadable';
  if (a !== b) return 'package.json dependencies differ';

  const lock = readJson(path.join(newDir, 'package-lock.json'));
  if (!lock || !lock.packages) return 'no lockfile to verify against';
  const installed = readJson(path.join(nm, '.package-lock.json'));
  if (!installed || !installed.packages) return 'installed tree has no record of what it contains';
  for (const [key, meta] of Object.entries(lock.packages)) {
    if (!key || meta.dev || meta.link) continue; // '' = root; dev packages aren't installed (--omit=dev)
    const have = installed.packages[key];
    if (!have) return `${key} is not installed`;
    if (have.version !== meta.version) return `${key} installed ${have.version}, needs ${meta.version}`;
  }
  return '';
}

// Pulls the real cause out of a crashed child's output: the first error line (and the
// exact module name for MODULE_NOT_FOUND / "Cannot find module"). `lines` = output tail.
function crashReason(lines) {
  const text = lines.join('\n');
  const mod = text.match(/Cannot find module '([^']+)'/) || text.match(/Cannot find package '([^']+)'/);
  const first = lines.find((l) => /(^|\s)(\w*Error\b|MODULE_NOT_FOUND|Cannot find)/.test(l)) || '';
  const head = [mod ? `missing module: ${mod[1]}` : '', first.trim().slice(0, 300)].filter(Boolean);
  return [...new Set(head)].join(' | ');
}

module.exports = { manifestKey, shareBlocker, crashReason };
