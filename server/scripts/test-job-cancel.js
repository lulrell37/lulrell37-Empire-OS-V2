// node server/scripts/test-job-cancel.js — cancelling persona jobs (server/jobProgress.js):
// [JOB_CANCEL] kills exactly one job (its children, its lock, its temp files) and leaves the rest running;
// an ambiguous match, a persona name alone and an unasked "all" cancel nothing; a CLIP_SCAN while one
// runs is refused (never replaces it); a cancelled job is never resumed.
process.env.CLIP_JOBS_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cancel-clipjobs-'));
const Module = require('module');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const settings = {};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './db') return { query: async () => ({ rows: [] }) };
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  return load.call(this, req, parent, ...rest);
};
const J = require('../jobProgress');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const errs = [];
console.error = (...a) => errs.push(a.join(' '));
console.warn = () => {};

// A fake job: a tracked job whose work is one long-running child process and one temp file.
function fake(persona, title) {
  const rec = { title, pid: 0, file: path.join(os.tmpdir(), `cancel-test-${Math.random().toString(36).slice(2)}`), lock: true, result: null };
  fs.writeFileSync(rec.file, 'x');
  rec.done = J.run(persona, title, ['One', 'Two'], async (job) => {
    job.onCancel(() => { rec.lock = false; fs.rmSync(rec.file, { force: true }); });
    job.step('One');
    const c = spawn('sleep', ['300']);
    rec.pid = c.pid;
    await new Promise((res, rej) => { c.on('close', () => rej(new Error('child died'))); });
    job.step('Two');
  }).then(() => { rec.result = 'done'; }, (e) => { rec.result = J.isCancel(e) ? 'cancelled' : 'failed'; });
  return rec;
}

(async () => {
  const a = fake('rogue', 'Clip scan: alpha.com/one');
  const b = fake('rogue', 'Clip scan: beta.com/two');
  const c = fake('jarvis', 'Website: Crab Shack');
  await sleep(300);
  const ids = J.live().map((j) => j.id);
  assert.strictEqual(ids.length, 3);
  assert.ok(alive(a.pid) && alive(b.pid) && alive(c.pid));
  const idOf = (title) => J.live().find((j) => j.title === title).id;

  // [JOBS] lists them live.
  const list = await J.tag('JOBS');
  assert.ok(/#\d+ · R\.O\.G\.U\.E\./.test(list) && /Crab Shack/.test(list) && /JOBS RUNNING \(3\)/.test(list), list);

  // Ambiguous words: nothing cancelled, the matches listed.
  let r = await J.tag('JOB_CANCEL', 'clip scan', { asked: 'cancel the clip scan' });
  assert.ok(/NONE/.test(r) && /alpha/.test(r) && /beta/.test(r), r);
  assert.strictEqual(J.live().length, 3);
  // No match.
  r = await J.tag('JOB_CANCEL', 'nonexistent thing', { asked: 'cancel it' });
  assert.ok(/nothing running matched/.test(r), r);
  assert.strictEqual(J.live().length, 3);
  // A persona's name alone never picks a job.
  for (const nm of ['rogue', 'R.O.G.U.E.', 'jarvis']) {
    r = await J.tag('JOB_CANCEL', nm, { asked: `cancel ${nm}` });
    assert.ok(/persona's name alone/.test(r), r);
  }
  assert.strictEqual(J.live().length, 3);
  // "all" without his own words is refused; so is it on a system turn.
  r = await J.tag('JOB_CANCEL', 'all', { asked: 'how is it going?' });
  assert.ok(/refused/.test(r), r);
  r = await J.tag('JOB_CANCEL', 'all', { asked: '' });
  assert.ok(/refused/.test(r), r);
  assert.strictEqual(J.live().length, 3);
  assert.ok(alive(a.pid) && alive(b.pid) && alive(c.pid));

  // Exact id cancels exactly that one.
  const bid = idOf(b.title);
  r = await J.tag('JOB_CANCEL', `#${bid}`, { asked: 'cancel the beta one' });
  assert.ok(new RegExp(`cancelled #${bid}`).test(r) && /untouched and still running \(2\)/.test(r) && /alpha/.test(r) && /Crab Shack/.test(r), r);
  await sleep(300);
  assert.ok(!alive(b.pid), 'its child is dead');
  assert.ok(alive(a.pid) && alive(c.pid), 'the other two children still run');
  assert.strictEqual(b.lock, false, 'its lock is released at once');
  assert.ok(!fs.existsSync(b.file), 'its temp file is gone');
  assert.ok(a.lock && c.lock && fs.existsSync(a.file) && fs.existsSync(c.file));
  assert.strictEqual(b.result, 'cancelled');
  assert.strictEqual(J._jobs()[bid].status, 'cancelled');
  assert.deepStrictEqual(J.live().map((j) => j.title).sort(), [a.title, c.title].sort());
  assert.ok(!errs.some((e) => /jobs failed/.test(e)), 'a cancel is not a failure: ' + errs.join('|'));

  // Unique words match one job.
  r = await J.tag('JOB_CANCEL', 'crab shack', { asked: 'cancel the crab shack site' });
  assert.ok(/cancelled #/.test(r) && /alpha/.test(r), r);
  await sleep(300);
  assert.ok(!alive(c.pid) && alive(a.pid));

  // Clean up the one still running (its failure lands before the registry is reset: ids restart at 1).
  process.kill(a.pid, 'SIGKILL'); await a.done; await sleep(50);

  // A cancelled job is never resumed at boot: only "running" ones are cut off.
  J._reset();
  assert.strictEqual(Object.keys(J._jobs()).length, 0);
  settings.jobs = JSON.stringify({ seq: 9, jobs: { 9: { id: '9', persona: 'rogue', title: 'Clip scan: z', steps: [], status: 'cancelled', resume: { kind: 'clip_scan', args: { url: 'https://x' } }, startedAt: 1, endedAt: 2 } } });
  let resumed = 0;
  J._setDeps({ tell: async () => {}, resumers: { clip_scan: () => { resumed++; } } });
  await J.recover();
  assert.strictEqual(resumed, 0, 'cancelled job not resumed');
  assert.strictEqual(J._jobs()[9].status, 'cancelled');
  J._setDeps({});

  // "cancel all" only on his literal words; it cancels persona jobs and says so.
  J._reset();
  const d = fake('rogue', 'Raw edit: d.com'), e = fake('ara', 'Deep research: tides');
  await sleep(300);
  r = await J.tag('JOB_CANCEL', 'all', { asked: 'cancel everything' });
  assert.ok(/Cancelled 2/.test(r), r);
  await sleep(300);
  assert.ok(!alive(d.pid) && !alive(e.pid) && J.live().length === 0);

  errs.length = 0; // (the one failure above was the test killing a job's child on purpose)
  // A CLIP_SCAN while one runs is refused, names the running job, cancels nothing; the lock frees on cancel.
  J._reset();
  const clip = require('../clipScan');
  const google = require('../google');
  let hang = null;
  google.driveDownloadTo = async () => { const ch = spawn('sleep', ['300']); hang = ch.pid; await new Promise((_, rej) => ch.on('close', () => rej(new Error('killed')))); };
  const url1 = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view';
  const url2 = 'https://drive.google.com/file/d/2ZzYyXxWwVvUuTtS/view';
  const scan = clip.clipScan(url1, '', { title: 'Clip scan: first' });
  const scanRes = scan.then(() => 'done', (x) => (J.isCancel(x) ? 'cancelled' : 'failed: ' + x.message));
  await sleep(500);
  assert.ok(hang && alive(hang));
  const running = J.live();
  assert.strictEqual(running.length, 1);
  await assert.rejects(clip.clipScan(url2, ''), (x) => /already running/.test(x.message) && x.message.includes(`#${running[0].id}`) && /first/.test(x.message) && /nothing was cancelled/.test(x.message) && x.busy);
  assert.ok(alive(hang), 'the running scan was not touched');
  assert.strictEqual(J.live().length, 1);
  const rr = await J.tag('JOB_CANCEL', 'first', { asked: 'cancel the first clip scan' });
  assert.ok(/cancelled #/.test(rr), rr);
  assert.strictEqual(await scanRes, 'cancelled');
  await sleep(200);
  assert.ok(!alive(hang), 'its download child is dead');
  assert.ok(!fs.existsSync(path.join(process.env.CLIP_JOBS_DIR, clip.jobKey(url1, ''))), 'its working folder is gone');
  // The lock is free: a new scan starts (and is itself then cancelled).
  const again = clip.clipScan(url2, '', { title: 'Clip scan: second' }).catch((x) => x);
  await sleep(500);
  assert.strictEqual(J.live().length, 1, 'a new scan started once the lock was released');
  await J.tag('JOB_CANCEL', 'second', { asked: 'cancel second' });
  assert.ok(J.isCancel(await again));
  assert.ok(!errs.some((x) => /jobs failed/.test(x)), errs.join('|'));
  console.log('job cancel: all checks passed');
  process.exit(0);
})().catch((e) => { console.error = console.log; console.error(e); process.exit(1); });
