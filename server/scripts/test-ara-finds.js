// node server/scripts/test-ara-finds.js — a worker stuck on information gets it
// from A.R.A. (his Gmail and Drive notes) before anyone asks him; the hand-off is
// posted in the group; a password stays out of the group; nothing found → null.
const Module = require('module');
const assert = require('assert');
const posts = [];
let answer = '{"found":true,"what":"the Canva password","value":"Hunter2!x","secret":true}';
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './llm') return { claudeText: async (sys) => (/plan searches/.test(sys) ? '{"gmail":["from:canva newer_than:30d"],"drive":["Canva"]}' : answer) };
  if (req === './google') return {
    gmailList: async () => '• Canva — Welcome  [id:m1]',
    gmailRead: async () => 'Email [id:m1]\nFrom: Canva\nSubject: Welcome\n\nYour account is him@example.com',
    driveSearch: async () => '• 11/20  Canva login  [id:d1]',
    driveRead: async () => 'Note "Canva login"\nemail him@example.com password Hunter2!x',
  };
  if (req === './groupChat') return { post: async (from, text) => posts.push({ from, text }) };
  return load.call(this, req, parent, ...rest);
};
const F = require('../araFinds');
(async () => {
  const got = await F.findForJob('Canva is asking for the password', { task: 'read the Canva pages', site: 'canva.com' });
  assert.deepStrictEqual(got, { what: 'the Canva password', value: 'Hunter2!x', secret: true });
  assert.strictEqual(posts[0].from, 'jarvis');
  assert.match(posts[1].text, /found it/);
  assert.ok(!posts.some((p) => /Hunter2/.test(p.text)), 'a password never shows in the group');
  answer = '{"found":false}';
  assert.strictEqual(await F.findForJob('the code texted to his phone'), null);
  assert.match(posts[posts.length - 1].text, /isn't there/);
  console.log('ara finds: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
