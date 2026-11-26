// The app's whisper-1 call through /ai/openai goes to Groq first (routes/ai.js swapModel).
const assert = require('assert');
(async () => {
  const f = new FormData();
  f.append('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/m4a' }), 'voice.m4a');
  f.append('model', 'whisper-1');
  f.append('language', 'en');
  const req = new Request('http://x', { method: 'POST', body: f });
  const ct = req.headers.get('content-type');
  const buf = Buffer.from(await req.arrayBuffer());
  const { _swapModel } = require('../routes/ai');
  const out = _swapModel(buf);
  assert.ok(out, 'model field swapped');
  const parsed = await new Response(out, { headers: { 'content-type': ct } }).formData();
  assert.strictEqual(parsed.get('model'), 'whisper-large-v3-turbo');
  assert.strictEqual(parsed.get('language'), 'en');
  assert.strictEqual(Buffer.from(await parsed.get('file').arrayBuffer()).toString(), 'fake audio bytes');
  assert.strictEqual(_swapModel(Buffer.from('no model here')), null);
  console.log('app voice groq: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
