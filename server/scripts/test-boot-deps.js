// boot.js's share-node_modules-or-npm-ci decision. No network.
// node server/scripts/test-boot-deps.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shareBlocker } = require('../depsCheck');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootdeps-'));
let n = 0;
function mk(deps, { lock, installed, extra = {} } = {}) {
  const d = path.join(tmp, String(n++));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps, ...extra }));
  const pk = (o) => ({ packages: { '': {}, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [`node_modules/${k}`, { version: v }])) } });
  if (lock) fs.writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify(pk(lock)));
  if (installed) {
    fs.mkdirSync(path.join(d, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(d, 'node_modules', '.package-lock.json'), JSON.stringify(pk(installed)));
    for (const [k, v] of Object.entries(installed)) {
      fs.mkdirSync(path.join(d, 'node_modules', k), { recursive: true });
      fs.writeFileSync(path.join(d, 'node_modules', k, 'package.json'), JSON.stringify({ name: k, version: v }));
    }
  }
  return d;
}
const L = { a: '1.0.0', b: '2.0.0' };
const old = mk({ a: '^1', b: '^2' }, { lock: L, installed: L });

assert.strictEqual(shareBlocker(mk({ a: '^1', b: '^2' }, { lock: L }), old), '', 'identical -> share');
assert.ok(shareBlocker(mk({ a: '^1', b: '^2', c: '^1' }, { lock: { ...L, c: '1.0.0' } }), old), 'added dep');
assert.ok(shareBlocker(mk({ a: '^1' }, { lock: { a: '1.0.0' } }), old), 'removed dep');
assert.ok(shareBlocker(mk({ a: '^1', b: '^3' }, { lock: { ...L, b: '3.0.0' } }), old), 'bumped dep');
assert.ok(shareBlocker(mk({ a: '^1', b: '^2' }, { lock: L, extra: { devDependencies: { t: '1' } } }), old), 'devDependencies change');
assert.ok(shareBlocker(mk({ a: '^1', b: '^2' }, { lock: L, extra: { overrides: { z: '1' } } }), old), 'overrides change');
// The #19 case: borrowed copy's package.json already lists c, but node_modules never got it.
const lockC = { ...L, c: '1.0.0' };
const ahead = mk({ a: '^1', b: '^2', c: '^1' }, { lock: lockC, installed: L });
assert.match(shareBlocker(mk({ a: '^1', b: '^2', c: '^1' }, { lock: lockC }), ahead), /c is not installed/);
// Same manifest, installed version differs from lock.
assert.ok(shareBlocker(mk({ a: '^1', b: '^2' }, { lock: { a: '1.0.0', b: '2.1.0' } }), old), 'stale version');
// Optimistic .package-lock.json record but the package is gone / wrong on disk.
const broken = mk({ a: '^1', b: '^2' }, { lock: L, installed: L });
fs.rmSync(path.join(broken, 'node_modules', 'b', 'package.json'));
assert.match(shareBlocker(mk({ a: '^1', b: '^2' }, { lock: L }), broken), /node_modules\/b not resolvable on disk/);
const wrongVer = mk({ a: '^1', b: '^2' }, { lock: L, installed: L });
fs.writeFileSync(path.join(wrongVer, 'node_modules', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '0.9.0' }));
assert.match(shareBlocker(mk({ a: '^1', b: '^2' }, { lock: L }), wrongVer), /not resolvable on disk/);
// Unknowns -> install.
assert.ok(shareBlocker(mk({ a: '^1', b: '^2' }), old), 'no lockfile');
assert.ok(shareBlocker(mk({ a: '^1', b: '^2' }, { lock: L }), mk({ a: '^1', b: '^2' }, { lock: L })), 'no node_modules');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('boot deps: ok');
