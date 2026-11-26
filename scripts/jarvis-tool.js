#!/usr/bin/env node
// Run J.A.R.V.I.S.'s command tags from a code worker's shell (server/workerTools.js).
//   node scripts/jarvis-tool.js '[SEARCH_WEB: gold price today]'
//   echo '[SAVE_NOTE: Title | long text]' | node scripts/jarvis-tool.js
// Reads EMPIRE_URL, WORKER (id) and WORKER_TOOLS_TOKEN from the job environment and prints
// the receipts. Anything that acts in the world (send, post, buy, delete, trade, merge, ship,
// redeploy) waits for Mr. Burrus's Confirm tap and says so. Exit 0 = the call went through
// (even if a tag warned); exit 1 = the call itself failed.
const fs = require('fs');

async function main() {
  const url = String(process.env.EMPIRE_URL || '').replace(/\/+$/, '');
  const token = process.env.WORKER_TOOLS_TOKEN || '';
  const id = process.env.WORKER || process.env.WORKER_ID || '';
  if (!url || !token || !id) { console.error('jarvis-tool: EMPIRE_URL, WORKER and WORKER_TOOLS_TOKEN must be set (the worker job sets them).'); process.exit(1); }
  let text = process.argv.slice(2).join(' ').trim();
  if (!text && !process.stdin.isTTY) text = fs.readFileSync(0, 'utf8').trim();
  if (!text) { console.error('jarvis-tool: give the tag text as an argument or on stdin, e.g. \'[SEARCH_WEB: query]\''); process.exit(1); }
  const r = await fetch(`${url}/worker-tools/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'x-worker-token': token, 'content-type': 'text/plain' }, body: text });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`jarvis-tool: ${r.status} ${body.error || 'failed'}`); process.exit(1); }
  console.log(body.receipts || '');
}
main().catch((e) => { console.error(`jarvis-tool: ${e.message}`); process.exit(1); });
