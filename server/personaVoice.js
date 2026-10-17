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

const { isFlat, stripCues } = require('./voiceCues');

// Voice ladder, same as the app's textToSpeech: ElevenLabs' expressive real-time
// v4 first — it performs the [laughs]/[sighs] cues personas write and runs at
// lower stability for more emotional range. If the account or voice can't use
// it (400/422) it's skipped until restart and flash takes over, cues stripped,
// style turned up.
const EL_LADDER = [
  { model: 'eleven_v4_turbo', cues: true, settings: { stability: 0.3, similarity_boost: 0.75 } },
  { model: 'eleven_flash_v2_5', cues: false, settings: { stability: 0.35, similarity_boost: 0.8, style: 0.4, use_speaker_boost: true } },
];
const FLAT_SETTINGS = { stability: 0.8, similarity_boost: 0.8, style: 0, use_speaker_boost: true }; // isFlat personas: even, no cues
const elRejected = new Set();

// The app's voice-speed slider (app_settings `voice_speed`, synced) -> ffmpeg
// args. atempo speeds speech up without raising the pitch.
async function tempoArgs() {
  const raw = await require('./syncStore').getSetting('voice_speed', '1').catch(() => '1');
  const r = Math.min(2, Math.max(0.75, parseFloat(raw) || 1));
  return Math.abs(r - 1) < 0.01 ? [] : ['-filter:a', `atempo=${r.toFixed(2)}`];
}

// Any audio ffmpeg can read on stdin -> OGG/Opus Buffer for a Telegram voice note.
async function toOgg(inputBuffer) {
  const tempo = await tempoArgs();
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      ...tempo,
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

async function elevenLabsOgg(voiceId, text, { flat = false } = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !voiceId) return null;
  const tiers = EL_LADDER.filter((t, i) => i === EL_LADDER.length - 1 || !elRejected.has(t.model))
    .map((t) => (flat ? { ...t, cues: false, settings: FLAT_SETTINGS } : t));
  for (const tier of tiers) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: (tier.cues ? String(text) : stripCues(text)).slice(0, 4000),
        model_id: tier.model,
        voice_settings: tier.settings,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 160);
      if ((res.status === 400 || res.status === 422) && tier.model !== tiers[tiers.length - 1].model) {
        console.warn(`elevenlabs: ${tier.model} rejected (${res.status}: ${detail}) — falling back`);
        elRejected.add(tier.model);
        continue;
      }
      throw new Error(`elevenlabs ${res.status}: ${detail}`);
    }
    const mp3 = Buffer.from(await res.arrayBuffer());
    if (mp3.length < 1500) return null;
    return toOgg(mp3);
  }
  return null;
}

// personaId + reply text -> OGG/Opus voice-note Buffer, or null (text-only).
async function synthesizePersonaVoice(personaId, replyText, { userText = '' } = {}) {
  const text = String(replyText || '').trim();
  if (!text) return null;
  if (personaId === 'ara') return synthesizeAraVoice(text, { userText });
  try {
    return await elevenLabsOgg(personaVoiceId(personaId), text, { flat: isFlat(personaId) });
  } catch (e) {
    console.error(`${personaId} voice failed:`, e.message);
    return null;
  }
}

module.exports = { synthesizePersonaVoice, tempoArgs };
