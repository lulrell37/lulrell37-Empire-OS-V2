// J.A.R.V.I.S.'s engine never drops a job without a word (server/jarvisEngine.js):
// running turns are logged to disk, the session is saved as soon as Claude Code
// reports it, an app job the app stopped listening to is handed to Telegram, and
// a turn a restart cut off is reported and resumed once.
//
//   node server/scripts/test-jarvis-engine.js
// Uses a fake Claude Code CLI (no tokens spent) and a stub Telegram sender.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-engine-test-'));
const fake = path.join(tmp, 'fake-claude.js');
fs.writeFileSync(fake, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  const wait = /SLOW/.test(input) ? 600 : 50;
  setTimeout(() => {
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] }, session_id: 'sess-1' });
    say({ type: 'result', subtype: 'success', is_error: false, result: 'Done, sir: ' + input.trim().slice(0, 40), session_id: 'sess-1', num_turns: 2 });
    process.exit(0);
  }, wait);
});
`);
fs.chmodSync(fake, 0o755);

process.env.CLAUDE_CLI_PATH = fake;
process.env.JARVIS_WORKDIR = tmp;
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
delete process.env.GITHUB_TOKEN; // read-only: no clone
delete process.env.JARVIS_ENGINE;

// Stub the Telegram side before the engine requires it.
const sent = [];
const tgPath = require.resolve('../routes/telegram');
require.cache[tgPath] = { id: tgPath, filename: tgPath, loaded: true, exports: {
  jarvisOutOfBand: async (text, opts = {}) => { sent.push({ text, ...opts }); return true; },
} };

const engine = require('../jarvisEngine');
const turnsFile = path.join(tmp, 'turns.json');
const sessionFile = path.join(tmp, 'session.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readTurns = () => { try { return JSON.parse(fs.readFileSync(turnsFile, 'utf8')); } catch { return {}; } };

(async () => {
  // 1. A running turn is on disk, its session saved before it ends; gone after.
  const p = engine.turn('SLOW fix the reveal', { source: 'telegram', ownerText: 'fix the reveal' });
  await sleep(300);
  const mid = Object.values(readTurns());
  assert.strictEqual(mid.length, 1, 'running turn is logged');
  assert.strictEqual(mid[0].text, 'fix the reveal');
  assert.strictEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).id, 'sess-1', 'session saved mid-turn');
  assert.match(await p, /^Done, sir/);
  assert.deepStrictEqual(readTurns(), {}, 'finished turn is unlogged');

  // 2. An app job the app keeps polling is not sent to Telegram.
  const watched = engine.startJob('quick one', 'persona');
  for (let i = 0; i < 20 && engine.jobStatus(watched).status === 'running'; i++) await sleep(50);
  assert.strictEqual(engine.jobStatus(watched).status, 'done');
  await sleep(50);
  assert.strictEqual(sent.length, 0, 'a collected answer stays in the app');

  // 3. Detached (he left the chat): it keeps running and the answer goes to Telegram.
  const left = engine.startJob('SLOW rebuild the chart', 'persona');
  await sleep(100);
  assert.ok(engine.detachJob(left));
  assert.strictEqual(sent.length, 0, 'nothing sent while still working');
  for (let i = 0; i < 40 && sent.length === 0; i++) await sleep(50);
  assert.strictEqual(sent.length, 1, 'detached job answered on Telegram');
  assert.strictEqual(sent[0].text, 'SLOW rebuild the chart');
  assert.match(sent[0].reply, /^Done, sir/);
  sent.length = 0;

  // 4. The stop button cancels: nothing is sent.
  const stopped = engine.startJob('SLOW never mind', 'persona');
  await sleep(100);
  engine.cancelJob(stopped);
  await sleep(200);
  assert.strictEqual(engine.jobStatus(stopped).status, 'cancelled');
  assert.strictEqual(sent.length, 0, 'a cancelled job is not sent anywhere');

  // 5. A restart: a leftover turn is reported and resumed once; a second time only reported.
  fs.writeFileSync(turnsFile, JSON.stringify({
    a: { id: 'a', text: 'fix gold trading', source: 'app', startedAt: Date.now() - 5 * 60000, resumes: 0 },
    b: { id: 'b', text: 'the thing that died twice', source: 'telegram', startedAt: Date.now(), resumes: 1 },
  }));
  const rec = await engine.recover();
  await sleep(20);
  assert.deepStrictEqual(rec.map((r) => r.resumed).sort(), [false, true]);
  const resume = sent.find((x) => x.text);
  assert.ok(resume, 'cut-off turn resumed');
  assert.strictEqual(resume.resumes, 1);
  assert.match(resume.text, /restarted[\s\S]*fix gold trading/);
  assert.match(resume.notice, /Picking it back up/);
  const twice = sent.find((x) => !x.text);
  assert.match(twice.notice, /twice/);
  assert.deepStrictEqual(readTurns(), {}, 'recover clears the log');

  console.log('test-jarvis-engine: all checks passed');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
