// Spoken voice for the Telegram bots.
//
//   ara       -> xAI realtime "ara" voice (server/araVoice.js), unchanged.
//   everyone  -> ElevenLabs, keyed by the persona's elevenlabsVoiceId, when
//   else         ELEVENLABS_API_KEY is set. No key (or no voice id) -> null and
//                the bot replies text-only.
//
// Best-effort throughout: any failure returns null. The encode uses the bundled
// ffmpeg-static binary (same as araVoice.js).
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { synthesizeAraVoice } = require('./araVoice');
const { personaVoiceId } = require('./personas');

const EL_MODEL = 'eleven_turbo_v2_5';

// Any audio ffmpeg can read on stdin -> OGG/Opus Buffer for a Telegram voice note.
function toOgg(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
      '-f', 'ogg', 'pipe:1',
    ]);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 200)}`))));
    ff.stdin.on('error', () => {});
    ff.stdin.end(inputBuffer);
  });
}

async function elevenLabsOgg(voiceId, text) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !voiceId) return null;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: String(text).slice(0, 4000), model_id: EL_MODEL }),
  });
  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const mp3 = Buffer.from(await res.arrayBuffer());
  if (mp3.length < 1500) return null;
  return toOgg(mp3);
}

// personaId + reply text -> OGG/Opus voice-note Buffer, or null (text-only).
async function synthesizePersonaVoice(personaId, replyText, { userText = '' } = {}) {
  const text = String(replyText || '').trim();
  if (!text) return null;
  if (personaId === 'ara') return synthesizeAraVoice(text, { userText });
  try {
    return await elevenLabsOgg(personaVoiceId(personaId), text);
  } catch (e) {
    console.error(`${personaId} voice failed:`, e.message);
    return null;
  }
}

module.exports = { synthesizePersonaVoice };
