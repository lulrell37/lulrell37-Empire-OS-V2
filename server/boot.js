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
const { spawn, execFileSync } = require('child_process');

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
  const res = await fetch(`https://api.github.com${p}`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${p}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

const depsKey = (dir) => {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return JSON.stringify([p.dependencies || {}, p.overrides || {}]);
  } catch { return ''; }
};

// Latest main, unpacked and ready to run -> { dir, sha, source } (dir = its server/).
async function prepare() {
  if (process.env.SELF_UPDATE === 'off') throw new Error('SELF_UPDATE=off');
  if (!process.env.GITHUB_TOKEN) throw new Error('no GITHUB_TOKEN');
  const head = await gh(`/repos/${REPO}/commits/main`);
  const sha = String(head.sha).slice(0, 12);
  if (lastGood && lastGood.sha === sha) return lastGood;
  const root = path.join(STORE, sha);
  const dir = path.join(root, 'server');
  if (!fs.existsSync(path.join(root, '.ready'))) {
    log(`downloading main @ ${sha}`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const tgz = `${root}.tgz`;
    fs.writeFileSync(tgz, await gh(`/repos/${REPO}/tarball/${head.sha}`, true));
    execFileSync('tar', ['-xzf', tgz, '-C', root, '--strip-components=1']);
    fs.rmSync(tgz, { force: true });
    if (!fs.existsSync(path.join(dir, 'index.js'))) throw new Error(`main @ ${sha} has no server/index.js`);
    // Same dependencies as what's installed here -> share node_modules; new ones -> install.
    if (depsKey(dir) === depsKey(BUNDLED) && fs.existsSync(path.join(BUNDLED, 'node_modules'))) {
      fs.symlinkSync(path.join(BUNDLED, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    } else {
      log(`main @ ${sha} changed dependencies — installing`);
      const lock = fs.existsSync(path.join(dir, 'package-lock.json'));
      execFileSync('npm', [lock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', timeout: 8 * 60e3 });
    }
    fs.writeFileSync(path.join(root, '.ready'), sha);
  }
  // Keep the store small: this one, the last good one, nothing else.
  for (const d of fs.readdirSync(STORE)) {
    if (d !== sha && (!lastGood || !lastGood.dir.includes(d))) fs.rm(path.join(STORE, d), { recursive: true, force: true }, () => {});
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
  try { want = await prepare(); } catch (e) {
    log(`not updating from GitHub: ${e.message}`);
    want = lastGood || BUNDLE;
  }
  const tries = [want, lastGood, BUNDLE].filter((c, i, a) => c && a.findIndex((x) => x && x.dir === c.dir) === i);
  let failed = '';
  for (const code of tries) {
    const run = await launch(code, failed ? { EMPIRE_FALLBACK_ERROR: failed } : {});
    if (run.ok) {
      lastGood = code;
      return run.exit;
    }
    await stop();
    const why = run.tail.slice(-8).join('\n').slice(-900);
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
