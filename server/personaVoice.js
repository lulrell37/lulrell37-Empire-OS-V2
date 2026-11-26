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
const { ARA_VOICE, ARA_SCRIPT, synthesizeAraVoice, araLongHint, ARA_LONG_CHARS, noWhisper } = require('./araVoice');
const { personaVoiceId } = require('./personas');

const { isFlat, stripCues, speakNames } = require('./voiceCues');

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
// A.R.A.: looser than the rest so the seductive range comes through.
const ARA_SETTINGS = {
  eleven_v4_turbo: { stability: 0.35, similarity_boost: 0.8 },
  eleven_flash_v2_5: { stability: 0.4, similarity_boost: 0.8, style: 0.7, use_speaker_boost: true },
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

// ElevenLabs and OpenAI take ~4000 characters a request. Longer text goes in
// pieces split on sentence ends, and the MP3s are joined into one voice note,
// so a long summary is never cut off partway.
const TTS_CHUNK = 3800;
function ttsChunks(text, max = TTS_CHUNK) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('... '), head.lastIndexOf('\n'));
    if (cut < max / 2) cut = head.lastIndexOf(' ');
    if (cut < max / 2) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function elevenLabsOgg(voiceId, text, { flat = false, personaId = '' } = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !voiceId) return null;
  const tiers = EL_LADDER.filter((t, i) => i === EL_LADDER.length - 1 || !elRejected.has(t.model))
    .map((t) => (flat ? { ...t, cues: false, settings: FLAT_SETTINGS }
      : personaId === 'ara' ? { ...t, settings: ARA_SETTINGS[t.model] || t.settings } : t));
  tiers: for (const tier of tiers) {
    const parts = [];
    for (const piece of ttsChunks(tier.cues ? String(text) : stripCues(text))) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ text: piece, model_id: tier.model, voice_settings: tier.settings }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 160);
        if ((res.status === 400 || res.status === 422) && tier.model !== tiers[tiers.length - 1].model) {
          console.warn(`elevenlabs: ${tier.model} rejected (${res.status}: ${detail}) — falling back`);
          elRejected.add(tier.model);
          continue tiers;
        }
        throw new Error(`elevenlabs ${res.status}: ${detail}`);
      }
      parts.push(Buffer.from(await res.arrayBuffer()));
    }
    const mp3 = Buffer.concat(parts);
    if (mp3.length < 1500) return null;
    return toOgg(mp3);
  }
  return null;
}

// Last-resort voice when the persona's own engine is down: OpenAI TTS (the
// key is already here for Whisper). Not her voice, but he still gets a note.
const OPENAI_FALLBACK_VOICE = { ara: 'shimmer', selene: 'nova', stephanie: 'coral', haven: 'sage', jarvis: 'onyx', aisha: 'fable', rogue: 'coral', talon: 'ash', atlas: 'sage', scout: 'nova', wire: 'shimmer', sage: 'sage', woke: 'echo' };
// Anyone else gets a backup voice that at least matches them (2026-11-26: R.O.G.U.E. fell
// back to the neutral "alloy" and didn't sound like herself).
const fallbackVoice = (id) => OPENAI_FALLBACK_VOICE[id] || (require('./personas').pronouns(id) === 'she/her' ? 'nova' : 'ash');
async function openaiOgg(personaId, text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const parts = [];
  for (const piece of ttsChunks(stripCues(text))) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: fallbackVoice(personaId), input: piece, response_format: 'mp3' }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`openai tts ${res.status}: ${(await res.text()).slice(0, 160)}`);
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  return toOgg(Buffer.concat(parts));
}

async function primaryOgg(personaId, text, userText, { voiceId, noEleven } = {}) {
  if (noEleven) throw new Error('ElevenLabs skipped (out of credits)');
  if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');
  const vid = voiceId || personaVoiceId(personaId);
  if (!vid) throw new Error('no ElevenLabs voice id for this persona');
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ogg = await elevenLabsOgg(vid, text, { flat: isFlat(personaId), personaId });
      if (ogg) return ogg;
      throw new Error('elevenlabs returned no audio');
    } catch (e) { last = e; }
  }
  throw last;
}

// A.R.A.'s reply -> what she'll actually say (her Grok brain, her voice
// direction, cues written in). Falls back to the reply itself.
// "T.A.L.O.N. → A.R.A." / "Talon to Ara" at the top -> "Talon" (whose message it is).
// `loose` (messages that reach her from the desks, not her own replies): any
// persona named on the first line — "Talon just opened…", "Wire — breaking news".
function relayFrom(text, loose = false) {
  // Every persona, dotted or plain, off the roster so a new one can't be missed.
  const { ROSTER } = require('./personas');
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = Object.entries(ROSTER).filter(([id]) => id !== 'ara').flatMap(([id, p]) => [esc(p.name), esc(id)]);
  const m = String(text || '').match(new RegExp(`^[^A-Za-z]*(${names.join('|')})\\s*(?:→|to)\\s*(?:A\\.R\\.A\\.|(?:Ara|Arra|Ar-rah)\\b)`, 'i'))
    // Names only, as written: "wire" or "scout" in lowercase is just a word.
    || (loose && String(text || '').split('\n')[0].match(new RegExp(`(?<![A-Za-z])(${Object.entries(ROSTER).filter(([id]) => id !== 'ara').flatMap(([, p]) => [esc(p.name), esc(speakNames(p.name).replace(/\.$/, ''))]).join('|')})(?![A-Za-z])`)));
  return m ? speakNames(m[1]).replace(/\.$/, '') : null; // alone, the name keeps its last dot
}

// Who a relayed message belongs to, for her script pass: it sees no roster, so it
// gets told here, with that persona's real pronouns.
function relayHint(text, loose = false) {
  const who = relayFrom(text, loose);
  if (!who) return '';
  const { ROSTER, resolvePersonaId, pronouns } = require('./personas');
  const id = resolvePersonaId(who);
  const she = pronouns(id) === 'she/her';
  const [He, him, his] = she ? ['She', 'her', 'her'] : ['He', 'him', 'his'];
  const role = ROSTER[id] ? `, the Empire's ${ROSTER[id].role}` : '';
  const word = id === 'woke' ? ' "Woke" here is his name, not the ordinary word.' : '';
  return `(These notes are ${who}'s message to you, in ${his.toUpperCase()} words — "I"/"my" means ${who}. ${who} is a separate persona${role}, a ${she ? 'woman' : 'man'} (${she ? 'she/her' : 'he/him'}): not you, not Mr. Burrus, and not any other persona the message mentions.${word} ${He} is talking to you, and you're passing it on to Mr. Burrus as ${his}: "${who} says…", "${she ? 'she' : 'he'}…". Not as yours, and not as if Mr. Burrus said it. Keep ${him} as the one speaking throughout. Don't read it out: you've read it, now tell him about it in your own sentences and your own order, what matters first, ${String(text || '').length > ARA_LONG_CHARS ? 'a bit longer than usual since it is long, but still you, never a report' : 'far shorter than this'}. He gets the full message as text.)\n\n`;
}

// Her script pass failed on someone else's message: say whose it is and give the
// start of it, rather than reading the whole thing out as if it were hers.
// A long one also gets its key lines (the ones with numbers in them), so he
// still hears the levels and times.
function relayFallback(text, who) {
  const body = String(text).replace(/^[^A-Za-z]*/, '').replace(new RegExp(`^${who}\\s*(?:→|to)\\s*Ara\\W*`, 'i'), '').trim();
  if (body.length <= 400) return `Message from ${who}, Mr. Burrus. ${body}`;
  const start = body.slice(0, 400).replace(/[^.!?]*$/, '') || body.slice(0, 400);
  let key = '';
  for (const line of body.slice(start.length).split(/\n+|(?<=[.!?])\s+/)) {
    const l = line.replace(/[*#`_•▪️-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/\d/.test(l) || key.length + l.length > 1200) continue;
    key += `${/[.!?]$/.test(l) ? l : `${l}.`} `;
  }
  return `Message from ${who}, Mr. Burrus. ${start}${key ? ` The key points: ${key.trim()}` : ''} The rest is in the message.`;
}

// Total time she may spend scripting one voice note, writers and repair together,
// so a voice note never hangs: past it she voices what she has (or the fallback).
const SCRIPT_BUDGET_MS = 80000;

async function araScript(text, userText, { relay = false } = {}) {
  const { mustSay, missingFrom, listFacts } = require('./scriptCoverage');
  const who = relayFrom(text, relay);
  const long = String(text || '').length > ARA_LONG_CHARS;
  const started = Date.now();
  const left = () => Math.max(1000, SCRIPT_BUDGET_MS - (Date.now() - started));
  const system = `${ARA_VOICE}\n\nYou are A.R.A. — full personal assistant to Mr. Burrus, sharp and a step ahead. You say "Mr. Burrus" only now and then, for a moment that calls for it: most of the time you don't use his name at all, you just talk to him.\n\n[THE TEAM, for who's who and their pronouns:\n${require('./personas').rosterLines()}\n]\n\n${ARA_SCRIPT}`;
  const timed = (p, ms) => {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('script timed out')), ms); });
    return Promise.race([timeout, p]).finally(() => clearTimeout(timer));
  };
  // Capped: Telegram sends her text after the voice note, so a slow script
  // mustn't hold the reply up — past 25s (45s for a long message) she voices
  // the reply as written.
  const write = (api, model) => timed(require('./llm').chatAs(api, model, system,
    [{ role: 'user', content: `${userText ? `Mr. Burrus just said: "${String(userText).slice(0, 1500)}"\n\n` : ''}${relayHint(text, relay)}${araLongHint(text)}What you want to get across (notes, not a script):\n${text}` }],
    { maxTokens: long ? 2200 : 1200, fallback: false }), Math.min(long ? 45000 : 25000, left()));
  const clean = (out) => String(out || '').replace(/\[[A-Z][A-Z0-9_]*(?::[^\]]*)?\]/g, '').replace(/[*#`_]/g, '').trim();
  // Her own reply can be voiced as written. A relay can't, so it gets a second writer.
  // The Claude backup gets the same ARA_VOICE system prompt.
  for (const [api, model] of who ? [['xai', 'grok-4'], ['anthropic', null]] : [['xai', 'grok-4']]) {
    try {
      let script = clean(await write(api, model));
      if (script) return await coverFacts(script);
    } catch (e) { console.error(`ara script failed (${api}):`, e.message); }
  }
  return who ? relayFallback(text, who) : text;

  // Every number, level, time and name in the source must be in the script.
  // One repair pass (Grok, only the missing items); still short after that, one
  // line at the end says them.
  async function coverFacts(script) {
    let items, missing;
    try {
      items = mustSay(text);
      missing = missingFrom(script, items);
    } catch (e) { console.error('ara coverage check failed:', e.message); return script; }
    if (!missing.length) return script;
    try {
      const fixed = clean(await timed(require('./llm').chatAs('xai', 'grok-4', system,
        [{ role: 'user', content: `This is your spoken script so far:\n${script}\n\nIt left out these facts from the message: ${listFacts(missing)}.\nWork each of them in, in your own words and your own attitude, where they fit. Don't rewrite the rest: keep everything else as it is. Reply with only the full script.` }],
        { maxTokens: long ? 2400 : 1400, fallback: false }), Math.min(20000, left())));
      if (fixed) { script = fixed; missing = missingFrom(script, items); }
    } catch (e) { console.error('ara script repair failed:', e.message); }
    if (missing.length) script = `${script} [husky] oh, and before I forget... ${listFacts(missing)}.`;
    return script;
  }
}

// personaId + reply text -> { ogg, error, fallback }. `ogg` is null only when
// every engine failed; `error` says why the persona's own voice didn't work.
// `scripted`: the text is already A.R.A.'s spoken script (the morning brief).
// `relay`: it reached her from the desks, so a persona named up top owns it.
async function voiceNote(personaId, replyText, { userText = '', scripted = false, relay = false, voiceId, noEleven = false } = {}) {
  // voiceId: use this ElevenLabs voice instead of the persona's own (group chat default).
  // noEleven: skip ElevenLabs (out of credits) and go straight to the backup voice.
  let text = speakNames(String(replyText || '').trim()); // "J.A.R.V.I.S." is said "Jarvis"
  if (!text) return { ogg: null };
  if (personaId === 'ara') {
    // The old voice, exactly as it was — one try, no backup voice.
    if ((await require('./syncStore').getSetting('ara_voice', 'elevenlabs').catch(() => 'elevenlabs')) === 'grok') {
      const ogg = await synthesizeAraVoice(noWhisper(text), { userText });
      return ogg ? { ogg } : { ogg: null, error: 'grok voice failed' };
    }
    if (!scripted) text = speakNames(await araScript(text, userText, { relay })).replace(/\[(?:breathy|breathily)\]\s*/gi, ''); // not in her voice, though the shared EMOTION block offers it
    text = noWhisper(text); // she never whispers (owner, 2026-11-26)
  }
  let error;
  try {
    const ogg = await primaryOgg(personaId, text, userText, { voiceId, noEleven });
    if (ogg) return { ogg };
  } catch (e) {
    error = e.message;
    console.error(`${personaId} voice failed:`, e.message);
  }
  // A.R.A. still sounds like herself if ElevenLabs is down: her Grok voice is next.
  if (personaId === 'ara') {
    const ogg = await synthesizeAraVoice(text, { userText }).catch(() => null);
    if (ogg) return { ogg, error, fallback: true };
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

module.exports = { synthesizePersonaVoice, voiceNote, tempoArgs, relayHint, relayFrom, araScript, ttsChunks };
