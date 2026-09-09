// A.R.A.'s spoken voice for the Telegram bot — the same voice she uses in the
// app: xAI's realtime model (`grok-voice-latest`, voice "ara"), server side.
//
// This mirrors CommandScreen.araGrokVoice: open the realtime socket, hand Grok
// the reply A.R.A.'s text turn already wrote, and ask it only to *deliver* that
// — her wording, her stance, spoken. The socket streams back 24kHz mono PCM,
// which ffmpeg encodes to OGG/Opus for a Telegram voice note.
//
// Everything here is best-effort: any failure returns null and the caller falls
// back to a text-only reply. Needs XAI_API_KEY; the encode needs the bundled
// ffmpeg-static binary.
const WebSocket = require('ws');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const WS_URL = 'wss://api.x.ai/v1/realtime?model=grok-voice-latest';

// A.R.A.'s character for the voice socket — deliberately just her personality
// plus the delivery instruction, NOT her full agent prompt (seeding the socket
// with tools/HUD context makes Grok answer afresh and wander off the reply).
const VOICE_INSTRUCTIONS = `You are A.R.A. — full personal assistant to Mr. Burrus. Warm, sharp, a step ahead; you call him "Mr. Burrus".

[VOICE MODE: You are speaking out loud — everything you say is heard, not read. Below is what Mr. Burrus just said and the reply you are giving him. Deliver that reply in your own natural spoken voice: same meaning, same stance, your phrasing. Stay strictly on that reply — do not answer with anything new, do not add topics, do not read it back word for word. Keep it conversational and tight.]`;

function voicePrompt(replyText, userText) {
  return (userText ? `Mr. Burrus just said: "${String(userText).slice(0, 1500)}"\n\n` : '')
    + `Deliver this reply out loud now, in your own spoken voice — same meaning and stance, your phrasing, on this and nothing else:\n"${replyText}"`;
}

// Open the realtime socket, get back one response as a PCM Buffer (s16le 24kHz mono).
function grokVoicePCM(key, replyText, userText) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, ['realtime', 'openai-insecure-api-key.' + key, 'openai-beta.realtime-v1']);
    const chunks = [];
    let ready = false;
    const done = (fn) => { try { ws.close(); } catch {} clearTimeout(timer); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error('grok voice timed out'))), 90000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          voice: 'ara',
          instructions: VOICE_INSTRUCTIONS,
          turn_detection: null,
          audio: {
            input: { format: { type: 'audio/pcm', rate: 24000 } },
            output: { format: { type: 'audio/pcm', rate: 24000 } },
          },
        },
      }));
    });
    ws.on('message', (raw) => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      if ((ev.type === 'session.created' || ev.type === 'session.updated') && !ready) {
        ready = true;
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: voicePrompt(replyText, userText) }] },
        }));
        ws.send(JSON.stringify({ type: 'response.create' }));
      } else if (ev.type === 'response.output_audio.delta' && ev.delta) {
        chunks.push(Buffer.from(ev.delta, 'base64'));
      } else if (ev.type === 'response.done') {
        done(() => resolve(Buffer.concat(chunks)));
      } else if (ev.type === 'error') {
        done(() => reject(new Error(ev.error && ev.error.message || ev.message || 'grok voice error')));
      }
    });
    ws.on('error', (e) => done(() => reject(e)));
  });
}

// PCM (s16le 24kHz mono) -> OGG/Opus Buffer, the format Telegram voice notes want.
function pcmToOgg(pcm) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
      '-f', 'ogg', 'pipe:1',
    ]);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 200)}`))));
    ff.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg bailed early
    ff.stdin.end(pcm);
  });
}

// Reply text -> OGG/Opus voice-note Buffer in A.R.A.'s voice, or null on any failure.
async function synthesizeAraVoice(replyText, { userText = '' } = {}) {
  const key = process.env.XAI_API_KEY;
  const text = String(replyText || '').trim();
  if (!key || !text) return null;
  try {
    const pcm = await grokVoicePCM(key, text.slice(0, 4000), userText);
    if (!pcm || pcm.length < 2000) return null;
    return await pcmToOgg(pcm);
  } catch (e) {
    console.error('ara voice failed:', e.message);
    return null;
  }
}

module.exports = { synthesizeAraVoice };
