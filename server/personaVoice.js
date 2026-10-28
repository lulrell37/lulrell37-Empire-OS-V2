// Spoken voice for the Telegram bots.
//
//   ara       -> Grok writes her spoken script (flirty, emotion cues in), then
//                ElevenLabs performs it in her voice at low stability. The
//                app's Settings › Voice switch (app_settings `ara_voice` =
//                'grok') puts her back on the old xAI realtime "ara" voice
//                (server/araVoice.js), untouched.
//   everyone  -> ElevenLabs, keyed by the persona's elevenlabsVoiceId, when
//   else         ELEVENLABS_API_KEY is set. No key (or no voice id) -> null and
//                the bot replies text-only.
//
// If the persona's own voice fails (after a retry) the note falls back to OpenAI
// TTS rather than silently going text-only; voiceNote() reports why. The encode
// uses the bundled ffmpeg-static binary (same as araVoice.js).
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { ARA_VOICE, ARA_SCRIPT, synthesizeAraVoice } = require('./araVoice');
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
// A.R.A.: looser than the rest so the seductive / playful range comes through.
const ARA_SETTINGS = {
  eleven_v4_turbo: { stability: 0.2, similarity_boost: 0.8 },
  eleven_flash_v2_5: { stability: 0.25, similarity_boost: 0.8, style: 0.7, use_speaker_boost: true },
};
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

async function elevenLabsOgg(voiceId, text, { flat = false, personaId = '' } = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !voiceId) return null;
  const tiers = EL_LADDER.filter((t, i) => i === EL_LADDER.length - 1 || !elRejected.has(t.model))
    .map((t) => (flat ? { ...t, cues: false, settings: FLAT_SETTINGS }
      : personaId === 'ara' ? { ...t, settings: ARA_SETTINGS[t.model] || t.settings } : t));
  for (const tier of tiers) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      signal: AbortSignal.timeout(60000),
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

// Last-resort voice when the persona's own engine is down: OpenAI TTS (the
// key is already here for Whisper). Not her voice, but he still gets a note.
const OPENAI_FALLBACK_VOICE = { ara: 'shimmer', selene: 'nova', stephanie: 'coral', haven: 'sage', jarvis: 'onyx' };
async function openaiOgg(personaId, text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: OPENAI_FALLBACK_VOICE[personaId] || 'alloy', input: stripCues(text).slice(0, 4000), response_format: 'mp3' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return toOgg(Buffer.from(await res.arrayBuffer()));
}

async function primaryOgg(personaId, text, userText) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');
  if (!personaVoiceId(personaId)) throw new Error('no ElevenLabs voice id for this persona');
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ogg = await elevenLabsOgg(personaVoiceId(personaId), text, { flat: isFlat(personaId), personaId });
      if (ogg) return ogg;
      throw new Error('elevenlabs returned no audio');
    } catch (e) { last = e; }
  }
  throw last;
}

// A.R.A.'s reply -> what she'll actually say (her Grok brain, her voice
// direction, cues written in). Falls back to the reply itself.
async function araScript(text, userText) {
  try {
    // Capped: Telegram sends her text after the voice note, so a slow script
    // mustn't hold the reply up — past 25s she just voices the reply as written.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('script timed out')), 25000));
    const out = await Promise.race([timeout, require('./llm').chatAs('xai', 'grok-4',
      `${ARA_VOICE}\n\nYou are A.R.A. — full personal assistant to Mr. Burrus, sharp and a step ahead; you call him "Mr. Burrus".\n\n${ARA_SCRIPT}`,
      [{ role: 'user', content: `${userText ? `Mr. Burrus just said: "${String(userText).slice(0, 1500)}"\n\n` : ''}What you want to get across (notes, not a script):\n${text}` }],
      { maxTokens: 1200, fallback: false })]);
    const script = String(out || '').replace(/\[[A-Z][A-Z0-9_]*(?::[^\]]*)?\]/g, '').replace(/[*#`_]/g, '').trim();
    if (script) return script;
  } catch (e) { console.error('ara script failed:', e.message); }
  return text;
}

// personaId + reply text -> { ogg, error, fallback }. `ogg` is null only when
// every engine failed; `error` says why the persona's own voice didn't work.
// `scripted`: the text is already A.R.A.'s spoken script (the morning brief).
async function voiceNote(personaId, replyText, { userText = '', scripted = false } = {}) {
  let text = String(replyText || '').trim();
  if (!text) return { ogg: null };
  if (personaId === 'ara') {
    // The old voice, exactly as it was — one try, no backup voice.
    if ((await require('./syncStore').getSetting('ara_voice', 'elevenlabs').catch(() => 'elevenlabs')) === 'grok') {
      const ogg = await synthesizeAraVoice(text, { userText });
      return ogg ? { ogg } : { ogg: null, error: 'grok voice failed' };
    }
    if (!scripted) text = await araScript(text, userText);
  }
  let error;
  try {
    const ogg = await primaryOgg(personaId, text, userText);
    if (ogg) return { ogg };
  } catch (e) {
    error = e.message;
    console.error(`${personaId} voice failed:`, e.message);
  }
  try {
    return { ogg: await openaiOgg(personaId, text), error, fallback: true };
  } catch (e) {
    console.error(`${personaId} fallback voice failed:`, e.message);
    return { ogg: null, error: error || e.message };
  }
}

// Back-compat: Buffer or null.
async function synthesizePersonaVoice(personaId, replyText, opts = {}) {
  return (await voiceNote(personaId, replyText, opts)).ogg;
}

module.exports = { synthesizePersonaVoice, voiceNote, tempoArgs };
