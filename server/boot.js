// Self-updating boot — `npm start` runs this, and it runs the real server
// (index.js) as a child process it watches over.
//
// Each start: download the latest `main` from GitHub (GITHUB_TOKEN), and run its
// server/. A copy that doesn't come up healthy within STARTUP_MS falls back to
// the last copy that did, then to the code bundled with this deployment — so a
// bad merge can't take the bots and T.A.L.O.N. down.
//
// A redeploy (J.A.R.V.I.S.'s [REDEPLOY], server/redeploy.js) is the child
// exiting with code 75: this loop pulls main again and starts it. The process
// Replit runs never exits, so nothing here depends on Replit restarting it.
//
// The child gets EMPIRE_SUPERVISED=1, EMPIRE_CODE_SHA, EMPIRE_CODE_SOURCE
// (github | bundled) and, after a fall back, EMPIRE_FALLBACK_ERROR — A.R.A.
// reports from those when it comes up. SELF_UPDATE=off runs the bundled code
// only (still supervised, still restartable).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pickShareSource, npmCrashed, crashReason } = require('./depsCheck');
const { spawn, spawnSync, execFileSync } = require('child_process');

const REPO = 'lulrell37/lulrell37-Empire-OS-V2';
const BUNDLED = __dirname;
const STORE = path.join(os.tmpdir(), 'empire-live');
const PORT = process.env.PORT || 3000;
const STARTUP_MS = 150 * 1000;
const RESTART_CODE = 75;

const log = (...a) => console.log('[boot]', ...a);
let bundledSha = 'bundled';
try { bundledSha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: BUNDLED, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'bundled'; } catch { /* no git in the deployment */ }
const BUNDLE = { dir: BUNDLED, sha: bundledSha, source: 'bundled' };

let lastGood = null;
let child = null;
let shuttingDown = false;

async function gh(p, raw = false) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${p}`, {
        headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json' },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status} on ${p}`), { status: res.status });
      return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
    } catch (e) {
      last = e;
      if (e.status && e.status < 500 && e.status !== 429) break; // a real answer, not a blip
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`${last.message} (GitHub ${p.split('?')[0]})`);
}

// Only server/ at `commit`, file by file, into `root`/server. The whole-repo
// tarball is ~75 MB (the app's 3D models and images) and timed out on the VM;
// server/ is a couple of MB.
async function downloadServer(commit, root) {
  const top = await gh(`/repos/${REPO}/git/trees/${commit}`);
  const entry = (top.tree || []).find((t) => t.path === 'server' && t.type === 'tree');
  if (!entry) throw new Error(`main @ ${commit.slice(0, 12)} has no server/ folder`);
  const tree = await gh(`/repos/${REPO}/git/trees/${entry.sha}?recursive=1`);
  if (tree.truncated) throw new Error('server/ tree too big to list');
  const files = tree.tree.filter((t) => t.type === 'blob' && !/^node_modules\//.test(t.path));
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const f = files[i++];
      const out = path.join(root, 'server', f.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, await gh(`/repos/${REPO}/git/blobs/${f.sha}`, true), { mode: f.mode === '100755' ? 0o755 : 0o644 });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  log(`main @ ${commit.slice(0, 12)}: ${files.length} server files downloaded`);
}

// Latest main, unpacked and ready to run -> { dir, sha, source } (dir = its server/).
async function prepare() {
  if (process.env.SELF_UPDATE === 'off') throw new Error('SELF_UPDATE=off');
  if (!process.env.GITHUB_TOKEN) throw new Error('no GITHUB_TOKEN');
  const head = await gh(`/repos/${REPO}/commits/main`);
  const sha = String(head.sha).slice(0, 12);
  if (lastGood && lastGood.sha === sha) return lastGood;
  // A commit whose install already failed isn't retried on every restart (each
  // try took minutes with nothing answering requests); a new commit on main clears it.
  const failMark = path.join(STORE, `${sha}.failed`);
  if (fs.existsSync(failMark)) throw new Error(fs.readFileSync(failMark, 'utf8'));
  const root = path.join(STORE, sha);
  const dir = path.join(root, 'server');
  if (!fs.existsSync(path.join(root, '.ready'))) {
    log(`downloading main @ ${sha}`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    await downloadServer(head.sha, root);
    if (!fs.existsSync(path.join(dir, 'index.js'))) throw new Error(`main @ ${sha} has no server/index.js`);
    // Share node_modules only when nothing differs (every dependency field AND the
    // installed tree vs the new lockfile — see depsCheck.js); otherwise install.
    // Any copy already installed can lend it: the one running now, other ready
    // copies in the store, then the bundled deploy.
    const ready = fs.readdirSync(STORE)
      .filter((d) => d !== sha && fs.existsSync(path.join(STORE, d, '.ready')))
      .sort((a, b) => fs.statSync(path.join(STORE, b, '.ready')).mtimeMs - fs.statSync(path.join(STORE, a, '.ready')).mtimeMs)
      .map((d) => path.join(STORE, d, 'server'));
    const { from, blocker } = pickShareSource(dir, [lastGood && lastGood.source === 'github' ? lastGood.dir : null, ...ready, BUNDLED]);
    let shared = false;
    if (from) {
      const src = fs.realpathSync(path.join(from, 'node_modules'));
      try {
        // The bundled deploy never goes away: link to it. A store copy can be
        // cleaned up later, so take a hard-linked copy (fast, no extra space).
        if (src === fs.realpathSync(path.join(BUNDLED, 'node_modules'))) fs.symlinkSync(src, path.join(dir, 'node_modules'), 'dir');
        else execFileSync('cp', ['-al', src, path.join(dir, 'node_modules')]);
        shared = true;
        log(`main @ ${sha}: sharing node_modules from ${from === BUNDLED ? 'the bundled deploy' : path.basename(path.dirname(from))}`);
      } catch (e) {
        log(`main @ ${sha}: couldn't share node_modules (${e.message}) — installing`);
        fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
      }
    }
    if (!shared) {
      if (!from) log(`main @ ${sha}: not sharing node_modules (${blocker}) — installing`);
      const lock = fs.existsSync(path.join(dir, 'package-lock.json'));
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const missingNow = () => Object.keys(pkg.dependencies || {}).filter((n) => !fs.existsSync(path.join(dir, 'node_modules', n, 'package.json')));
      let npm, out, missing;
      // One more try when npm itself crashed mid-install (it exits 0 and leaves the tree half done).
      for (let attempt = 1; attempt <= 2; attempt++) {
        npm = spawnSync('npm', [lock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 8 * 60e3 });
        out = `${npm.stdout || ''}\n${npm.stderr || ''}`;
        process.stdout.write(out);
        missing = missingNow();
        if (npm.status === 0 && !npm.error && !missing.length) break;
        if (attempt === 1 && npmCrashed(out)) { log(`main @ ${sha}: npm crashed mid-install — trying once more`); fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); continue; }
        break;
      }
      // A failed/partial install must fail loudly here, with npm's own reason, not as MODULE_NOT_FOUND in the child.
      if (npm.status !== 0 || npm.error || missing.length) {
        const errLines = out.split('\n').filter((l) => /npm error|ERR!|Error:/i.test(l) && !/complete log/i.test(l)).slice(-12).join('\n');
        const msg = `main @ ${sha}: npm ${lock ? 'ci' : 'install'} failed${npm.error ? ` (${npm.error.message})` : ` (exit ${npm.status})`}${missing.length ? `; missing: ${missing.join(', ')}` : ''}\n${errLines || out.trim().split('\n').slice(-12).join('\n')}`.slice(0, 2500);
        fs.rmSync(root, { recursive: true, force: true });
        fs.writeFileSync(failMark, msg);
        throw new Error(msg);
      }
    }
    fs.writeFileSync(path.join(root, '.ready'), sha);
  }
  // Keep the store small: this one, the last good one, nothing else.
  for (const d of fs.readdirSync(STORE)) {
    if (d !== sha && !d.endsWith('.failed') && (!lastGood || !lastGood.dir.includes(d))) fs.rm(path.join(STORE, d), { recursive: true, force: true }, () => {});
  }
  return { dir, sha, source: 'github' };
}

function healthy() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 4000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Start `code`; resolve { ok, exit, tail } once it answers /health, or it dies / times out.
function launch(code, extraEnv = {}) {
  log(`starting ${code.source} @ ${code.sha}`);
  const tail = [];
  const keep = (buf) => { for (const l of String(buf).split('\n')) if (l.trim()) { tail.push(l); if (tail.length > 30) tail.shift(); } };
  child = spawn(process.execPath, ['index.js'], {
    cwd: code.dir,
    env: { ...process.env, ...extraEnv, EMPIRE_SUPERVISED: '1', EMPIRE_CODE_SHA: code.sha, EMPIRE_CODE_SOURCE: code.source },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => { process.stdout.write(b); keep(b); });
  child.stderr.on('data', (b) => { process.stderr.write(b); keep(b); });
  const exit = new Promise((r) => child.once('exit', (c, sig) => r(c ?? (sig ? 1 : 0))));
  const ready = (async () => {
    const until = Date.now() + STARTUP_MS;
    let dead = false;
    exit.then(() => { dead = true; });
    while (Date.now() < until && !dead) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!dead && await healthy()) return true;
    }
    return false;
  })();
  return ready.then((ok) => ({ ok, exit, tail }));
}

// Once it's up, keep checking it answers. A child that stops answering /health
// (event loop wedged, or the VM thrashing for memory) never exits, so without
// this the server stayed dead until a manual redeploy. FREEZE_MISSES checks in
// a row (~2 min) → kill it; the loop below restarts it, and A.R.A. says why.
const WATCH_MS = Number(process.env.FREEZE_WATCH_MS || 30 * 1000);
const FREEZE_MISSES = Number(process.env.FREEZE_MISSES || 4);
let restartReason = '';

function memLine(pid) {
  let rss = '';
  try { rss = (/VmRSS:\s*(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')) || [])[1]; } catch { /* gone */ }
  const mb = (b) => `${Math.round(b / 1048576)} MB`;
  return `server memory ${rss ? mb(rss * 1024) : '?'}; machine ${mb(os.freemem())} free of ${mb(os.totalmem())}`;
}

function watch(run) {
  if (process.env.FREEZE_WATCH === 'off') return;
  let misses = 0;
  let busy = false;
  const proc = child;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    const ok = await healthy();
    busy = false;
    if (proc.exitCode != null || proc.signalCode) return clearInterval(t);
    misses = ok ? 0 : misses + 1;
    if (misses < FREEZE_MISSES) return;
    clearInterval(t);
    restartReason = `froze — stopped answering for ${Math.round((misses * WATCH_MS) / 60000)} min (${memLine(proc.pid)}). Last output:\n${run.tail.slice(-12).join('\n').slice(-1500)}`;
    log(`server ${restartReason.split('\n')[0]} — killing it`);
    proc.kill('SIGKILL');
  }, WATCH_MS);
  run.exit.then(() => clearInterval(t));
}

async function stop() {
  if (!child || child.exitCode != null) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), 10000);
  await gone;
  clearTimeout(t);
}

async function cycle() {
  let want;
  let failed = '';
  try { want = await prepare(); } catch (e) {
    log(`not updating from GitHub: ${e.message}`);
    if (!/^(SELF_UPDATE=off|no GITHUB_TOKEN)$/.test(e.message)) failed = e.message; // A.R.A.'s boot report says why main isn't live
    want = lastGood || BUNDLE;
  }
  const tries = [want, lastGood, BUNDLE].filter((c, i, a) => c && a.findIndex((x) => x && x.dir === c.dir) === i);
  for (const code of tries) {
    const env = { ...(failed ? { EMPIRE_FALLBACK_ERROR: failed } : {}), ...(restartReason ? { EMPIRE_RESTART_REASON: restartReason } : {}) };
    const run = await launch(code, env);
    if (run.ok) {
      lastGood = code;
      restartReason = '';
      watch(run);
      return run.exit.then((c) => {
        if (!restartReason && c !== RESTART_CODE && !shuttingDown) restartReason = `crashed (exit ${c}). Last output:\n${run.tail.slice(-12).join('\n').slice(-1500)}`;
        return c;
      });
    }
    await stop();
    const cause = crashReason(run.tail);
    const why = (cause ? `${cause}\n` : '') + run.tail.slice(-15).join('\n').slice(-2500);
    log(`${code.source} @ ${code.sha} did not come up healthy`);
    failed = `${code.source === 'github' ? 'main' : code.source} @ ${code.sha} crashed on startup:\n${why || '(no output)'}`;
  }
  throw new Error(`nothing came up — ${failed}`);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { shuttingDown = true; await stop().catch(() => {}); process.exit(0); });
}

(async () => {
  for (;;) {
    let code;
    try { code = await cycle(); } catch (e) {
      console.error('[boot]', e.message);
      process.exit(1); // even the bundled code won't start — let Replit restart the deployment
    }
    if (shuttingDown) return;
    if (code === RESTART_CODE) { log('redeploy requested — pulling main'); continue; }
    log(`server exited (${code}) — restarting in 5s`);
    await new Promise((r) => setTimeout(r, 5000));
  }
})();
