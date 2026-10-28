// Diagnose A.R.A.'s Telegram voice: opens the same xAI realtime socket
// araVoice.js uses and prints every event type xAI sends back, plus any error.
//
//   XAI_API_KEY=xai-... node server/scripts/test-ara-voice.js
const WebSocket = require('ws');

const key = process.env.XAI_API_KEY;
if (!key) { console.error('Set XAI_API_KEY first: XAI_API_KEY=xai-... node server/scripts/test-ara-voice.js'); process.exit(1); }

const ws = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', ['realtime', 'openai-insecure-api-key.' + key, 'openai-beta.realtime-v1']);
let audioBytes = 0;
let ready = false;
const seen = {};
const t0 = Date.now();
const stop = (code) => { try { ws.close(); } catch {} setTimeout(() => process.exit(code), 200); };
setTimeout(() => { console.log('TIMED OUT after 60s. Events seen:', seen); stop(1); }, 60000);

ws.on('unexpected-response', (req, res) => {
  let body = '';
  res.on('data', (d) => { body += d; });
  res.on('end', () => { console.log(`CONNECTION REFUSED: HTTP ${res.statusCode} ${body.slice(0, 500)}`); stop(1); });
});
ws.on('open', () => {
  console.log('connected');
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      voice: 'ara',
      instructions: 'You are A.R.A. Say the text you are given, warmly.',
      turn_detection: null,
      audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
    },
  }));
});
ws.on('message', (raw) => {
  let ev;
  try { ev = JSON.parse(raw.toString()); } catch { return; }
  seen[ev.type] = (seen[ev.type] || 0) + 1;
  if (seen[ev.type] === 1) console.log(`event: ${ev.type}`);
  if ((ev.type === 'session.created' || ev.type === 'session.updated') && !ready) {
    ready = true;
    ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say: testing, one two three.' }] } }));
    ws.send(JSON.stringify({ type: 'response.create' }));
  } else if (ev.type === 'response.output_audio.delta' && ev.delta) {
    audioBytes += Buffer.from(ev.delta, 'base64').length;
  } else if (ev.type === 'error') {
    console.log('XAI ERROR:', JSON.stringify(ev).slice(0, 800));
  } else if (ev.type === 'response.done') {
    const r = ev.response || {};
    console.log(`response.done: status=${r.status} ${r.status_details ? JSON.stringify(r.status_details).slice(0, 400) : ''}`);
    console.log(audioBytes > 2000
      ? `OK — got ${audioBytes} bytes of audio in ${Date.now() - t0}ms. The voice service works.`
      : `NO AUDIO (${audioBytes} bytes). Events seen: ${JSON.stringify(seen)}`);
    stop(audioBytes > 2000 ? 0 : 1);
  }
});
ws.on('error', (e) => { console.log('SOCKET ERROR:', e.message); stop(1); });
ws.on('close', (code, reason) => console.log(`socket closed: ${code} ${reason || ''}`));
