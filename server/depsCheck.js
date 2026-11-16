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

module.exports = { manifestKey, shareBlocker };
