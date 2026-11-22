// node server/scripts/test-transcribe.js — [TRANSCRIBE]'s link rules and output
// format (no network: nothing is downloaded or sent to Whisper).
const assert = require('assert');
const t = require('../transcribe');

const ok = {
  'https://www.instagram.com/reel/DaRu78VODZM/?igsh=MWhtZDQ5enNqbmc1Mg==': 'instagram',
  'https://instagram.com/p/Cxyz123/': 'instagram',
  'https://www.instagram.com/someuser/reel/Cxyz123/': 'instagram',
  'https://www.instagram.com/tv/Cxyz123/': 'instagram',
  'https://www.tiktok.com/@user/video/7300000000000000000': 'tiktok',
  'https://vm.tiktok.com/ZMabc123/': 'tiktok',
  'https://youtu.be/dQw4w9WgXcQ': 'youtube',
  'https://www.youtube.com/shorts/dQw4w9WgXcQ': 'youtube',
  'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view': 'drive',
};
for (const [u, k] of Object.entries(ok)) assert.strictEqual(t.sourceOf(u), k, u);
for (const u of ['https://www.instagram.com/someuser/', 'https://example.com/v.mp4', 'not a link', 'https://www.youtube.com/playlist?list=PL1'])
  assert.strictEqual(t.sourceOf(u), null, `refused: ${u}`);

assert.strictEqual(t.formatTranscript([{ start: 0, end: 3, text: ' Hello there. ' }, { start: 65.4, end: 70, text: 'One minute in.' }]),
  '[0:00] Hello there.\n[1:05] One minute in.');
assert.ok(/\[TRANSCRIBE: link\]/.test(t.TRANSCRIBE_TOOLS));

(async () => {
  await assert.rejects(t.transcribeLink('https://example.com/x'), /YouTube, Instagram, TikTok or Google Drive/);
  console.log('transcribe: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
