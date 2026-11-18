#!/usr/bin/env node
// Turns a phone crash stack ("address at index.android.bundle:1:2170987") back
// into source lines.
//
// The release APK runs Hermes bytecode, so its stack frames are bytecode
// offsets, not file:line. This rebuilds the exact JS bundle for a commit the
// way EAS does (expo export:embed → hermesc -O with a source map), composes the
// two maps and looks every frame up, printing the source line it lands on.
//
//   node scripts/symbolicate-crash.js <stack.txt | -> [--ref <commit>]...
//
// Give one --ref per commit the APK might have been built from (default: HEAD).
// A ref is a fit when the frames land on real calls (a "loopN" frame inside a
// loop body, its caller on the call of that loop) — a wrong commit lands on
// comments, blank lines or nonsense. The latest APK is the newest
// "Build Android APK" run on main: `gh run list -w build.yml -L 5`.
// Builds are cached per commit in $TMPDIR/empire-symbolicate/<sha>.
//
// The repo has no lockfile, so EAS resolves dependency versions fresh on every
// build: offsets from this checkout's node_modules can drift by a few hundred
// bytes. For an exact-ish match, install fresh next to it and point at it:
//   mkdir -p /tmp/fresh && git show <sha>:package.json > /tmp/fresh/package.json
//   (cd /tmp/fresh && npm install --ignore-scripts --legacy-peer-deps)
//   node scripts/symbolicate-crash.js stack.txt --ref <sha> --modules /tmp/fresh/node_modules
// When two installs disagree, trust the frames they agree on.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const refs = [];
let stackFile = null;
let modules = null; // node_modules to bundle with (default: this checkout's)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ref') refs.push(args[++i]);
  else if (args[i] === '--modules') modules = path.resolve(args[++i]);
  else stackFile = args[i];
}
if (!stackFile) {
  console.error('usage: node scripts/symbolicate-crash.js <stack.txt | -> [--ref <commit>]...');
  process.exit(2);
}
if (!refs.length) refs.push('HEAD');
const stack = fs.readFileSync(stackFile === '-' ? 0 : stackFile, 'utf8');

// "at ?anon_0__loop3 (address at index.android.bundle:1:2170987)"
const frames = [];
for (const line of stack.split('\n')) {
  const m = /at\s+(.*?)\s*\(address at [^:]*:(\d+):(\d+)\)/.exec(line);
  if (m) frames.push({ fn: m[1], line: +m[2], col: +m[3] });
}
if (!frames.length) { console.error('no "address at …:line:col" frames in that stack'); process.exit(2); }

const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts }) + '';
const hermesc = path.join(repo, 'node_modules/react-native/sdks/hermesc',
  process.platform === 'darwin' ? 'osx-bin' : 'linux64-bin', 'hermesc');

function build(ref) {
  const sha = sh('git', ['rev-parse', ref]).trim();
  const tag = modules ? '-' + require('crypto').createHash('sha1').update(modules).digest('hex').slice(0, 8) : '';
  const out = path.join(os.tmpdir(), 'empire-symbolicate', sha + tag);
  const composed = path.join(out, 'composed.map');
  if (fs.existsSync(composed)) return { sha, out, composed };
  fs.mkdirSync(out, { recursive: true });
  const wt = path.join(out, 'src');
  if (!fs.existsSync(wt)) sh('git', ['worktree', 'add', '--detach', wt, sha]);
  // Same dependencies as this checkout unless --modules says otherwise. If
  // package.json differs at that commit the offsets can drift — say so.
  const pkgDiff = sh('git', ['diff', '--name-only', sha, '--', 'package.json']).trim();
  if (pkgDiff && !modules) console.warn(`! ${sha.slice(0, 7)}: package.json differs from this checkout — use --modules, results may be off`);
  if (!fs.existsSync(path.join(wt, 'node_modules'))) fs.symlinkSync(modules || path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
  console.error(`building the release bundle for ${sha.slice(0, 7)} (about a minute)…`);
  const bundle = path.join(out, 'index.android.bundle');
  sh('npx', ['expo', 'export:embed', '--platform', 'android', '--dev', 'false', '--entry-file', 'index.js',
    '--bundle-output', bundle, '--sourcemap-output', bundle + '.map', '--assets-dest', path.join(out, 'assets'), '--reset-cache'],
  { cwd: wt, stdio: ['ignore', 'ignore', 'inherit'] });
  sh(hermesc, ['-emit-binary', '-out', path.join(out, 'index.hbc'), '-O', '-output-source-map', '-w', bundle]);
  sh('node', [path.join(repo, 'node_modules/react-native/scripts/compose-source-maps.js'),
    bundle + '.map', path.join(out, 'index.hbc.map'), '-o', composed]);
  return { sha, out, composed };
}

(async () => {
  const { SourceMapConsumer } = require(path.join(repo, 'node_modules/source-map'));
  for (const ref of refs) {
    const { sha, out, composed } = build(ref);
    const wt = path.join(out, 'src');
    console.log(`\n=== ${ref} (${sha.slice(0, 7)}) ===`);
    await SourceMapConsumer.with(JSON.parse(fs.readFileSync(composed, 'utf8')), null, (c) => {
      for (const f of frames) {
        const p = c.originalPositionFor({ line: f.line, column: f.col });
        const src = p.source ? p.source.replace(/^.*?\/(src|node_modules|App\.js|index\.js)/, '$1') : null;
        let code = '';
        if (src && !src.startsWith('node_modules')) {
          try { code = fs.readFileSync(path.join(wt, src), 'utf8').split('\n')[p.line - 1].trim().slice(0, 160); } catch {}
        }
        console.log(`${f.fn}  →  ${src ? `${src}:${p.line}:${p.column}` : '?'}${p.name ? ` (${p.name})` : ''}`);
        if (code) console.log(`      ${code}`);
      }
    });
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
