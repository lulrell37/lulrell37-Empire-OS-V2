// The phone line between J.A.R.V.I.S. and his workers (workerTools askJarvis / inbox, workers.message).
const assert = require('assert');
const store = {};
const sync = { getSetting: async (k, f) => (k in store ? store[k] : f), setSetting: async (k, v) => { store[k] = String(v); } };
const wt = require('../workerTools');
const workers = require('../workers');
(async () => {
  // A worker's question reaches J.A.R.V.I.S. with its task, and his answer comes back.
  let asked = '';
  wt._setDeps({ sync, workers: { get: async () => ({ id: '9', slot: 2, title: 'Groq account', task: 'make a Groq account and get an API key' }) } });
  const out = await wt.askJarvis('9', 'which email should the account use?', { relay: async (m) => { asked = m; return 'Use his main Gmail; A.R.A. confirmed it.'; } });
  assert.match(asked, /ONE OF YOUR OWN WORKERS — worker 2 of 5 \("Groq account"\)/);
  assert.match(asked, /make a Groq account/);
  assert.match(asked, /which email/);
  assert.match(out, /J\.A\.R\.V\.I\.S\. ANSWERS:\nUse his main Gmail/);

  // His message to a running worker lands in its inbox once.
  await wt.sendToWorker('9', 'use the Google sign-in instead');
  let box = await wt.readInbox('9');
  assert.match(box, /use the Google sign-in instead/);
  box = await wt.readInbox('9');
  assert.match(box, /nothing new/);

  // The tag goes through the endpoint's run() without touching other tags.
  wt._setDeps({ sync, workers: { get: async () => null }, runtime: { findTags: (t) => [{ name: 'WORKER_INBOX', arg: '' }] } });
  assert.match(await wt.run('9', '[WORKER_INBOX]'), /nothing new/);

  // [WORKER_MESSAGE] needs a running code worker.
  assert.match(await workers.message('no bar here'), /give the worker and the message/);
  assert.match(await workers.message('3 | hello'), /no worker 3 running/);
  console.log('worker phone: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
