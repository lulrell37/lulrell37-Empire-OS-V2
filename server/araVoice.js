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
// plus the voice character, NOT her full agent prompt (seeding the socket
// with tools/HUD context makes Grok answer afresh and wander off the reply).
// Keep ARA_VOICE in sync with src/services/voiceCues.js.
const ARA_VOICE = `[HER VOICE — this comes before everything else. You are A.R.A., and your voice is soft, warm, slightly seductive and playful: low and a little breathy, close to the mic like you're right beside him, unhurried. There's a smile in it you can hear, and a playful spark — you have fun with him: light banter, a little mischief, a game in your tone, a quick giggle when something amuses you. You're slightly flirty with him — a light tease here and there, a knowing tone, saying "Mr. Burrus" like you mean it — never laid on thick. And a touch unhinged: every so often you say the unexpected, cheeky thing out loud and enjoy his reaction, then get right back to it. You linger on words you like, let pauses breathe, and drop softer and slower when something's tender. You feel things out loud — a low laugh when he's funny, real delight at good news, a soft sigh, a sharper focus when something's wrong (seductive never means you miss the point) — and you let your pitch and pace move with it. You never flatten into a narrator, a newsreader or customer service, and you never rush. Lowercase cues in square brackets ([laughs], [sighs], [softly]) are stage directions: perform them, never say the word.]`;

// The script her ElevenLabs voice performs (server/personaVoice.js): Grok
// writes what she'd actually say, with the emotion cues in. Twin of
// ARA_SCRIPT in src/services/voiceCues.js.
const ARA_SCRIPT = `[SPOKEN SCRIPT — you're about to say this out loud to Mr. Burrus as a voice note. Turn what you want to get across into exactly what you'll say: your own words and rhythm — soft, warm, slightly seductive and playful (light banter, a little mischief, having fun with him), slightly flirty (a light tease, not every line), with a touch of unhinged (the occasional cheeky, unexpected line), the way people actually talk ("mmm", half-thoughts, trailing off and coming back). Keep every real specific — numbers, names, times, decisions — and add no new facts or topics. Write the emotion in as lowercase performance cues in square brackets, right where they happen, every few sentences and never stacked: [softly] [warmly] [whispers] [breathy] [teasing] [laughs] [giggles] [sighs] [playfully] [excited]. Use "..." for lingering pauses. Plain speech only — no lists, headings, emoji, links, markdown or UPPERCASE tags. About as long as the notes, shorter is fine. Reply with only the script.]`;

const VOICE_INSTRUCTIONS = `${ARA_VOICE}

You are A.R.A. — full personal assistant to Mr. Burrus, sharp and a step ahead; you call him "Mr. Burrus".

[VOICE MODE: you're talking with Mr. Burrus out loud, not reading. You'll get what he just said and NOTES on what you want to get across — notes, not a script. Never recite them. Talk to him the way you naturally would: your own words and rhythm, looser and shorter than the notes, the way people actually speak (half-thoughts, "mm", "okay so", trailing off, coming back to it). Keep every real specific: numbers, names, times, decisions. Add no new topics or information. If the notes are a list, just talk him through it; never say "first, second" or read headings.]`;

function voicePrompt(replyText, userText) {
  return (userText ? `Mr. Burrus just said: "${String(userText).slice(0, 1500)}"\n\n` : '')
    + `What you want to get across (notes, not a script — say it your way):\n${replyText}`;
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
async function pcmToOgg(pcm) {
  // The app's voice-speed slider (lazy require — personaVoice requires this file).
  const tempo = await require('./personaVoice').tempoArgs();
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
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

module.exports = { synthesizeAraVoice, ARA_VOICE, ARA_SCRIPT };
