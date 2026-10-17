// Eyes for the Telegram bots — turns a photo or video he sends into a detailed
// written account the persona's turn can read. Done as a separate "look" step
// (rather than handing the image to each persona's own model) so it works the
// same for every persona whatever provider it speaks on, and so the account
// lands in tg_messages history: "what was on that label?" two messages later
// still has something to go on.
//
// Photos: Claude API -> OpenAI gpt-4o -> Grok -> Gemini, first key that answers.
// Videos: Gemini watches the clip natively (picture + sound) when GEMINI_API_KEY
// is set; otherwise ffmpeg pulls evenly spaced frames, Whisper transcribes the
// audio track, and the frames go through the photo chain with the transcript.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { CLAUDE_MODEL, keyFor, transcribe } = require('./llm');

const LOOK_PROMPT = `You are the eyes for a personal assistant who can't see this herself. Describe what's here so she can answer him as if she saw it: the subject, setting, people (appearance, expressions, what they're doing — never guess identities), objects, colors, and ALL visible text transcribed exactly (labels, screens, documents, receipts, signs, numbers). If it's a screenshot, document or chart, transcribe the content and structure. Note anything notable or unusual. Plain prose, no preamble, no opinions about what she should say.`;

const MAX_FRAMES = 8;

// --- providers ---------------------------------------------------------

async function claudeLook(images, prompt) {
  const content = [
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data.toString('base64') } })),
    { type: 'text', text: prompt },
  ];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': keyFor('anthropic'), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1500, system: LOOK_PROMPT, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  return (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// OpenAI and xAI share the chat-completions image_url shape.
async function openaiCompatLook(provider, images, prompt) {
  const base = provider === 'xai' ? 'https://api.x.ai' : 'https://api.openai.com';
  const model = provider === 'xai' ? 'grok-4' : 'gpt-4o';
  const content = [
    ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data.toString('base64')}` } })),
    { type: 'text', text: prompt },
  ];
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keyFor(provider)}` },
    body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'system', content: LOOK_PROMPT }, { role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
}

// Gemini takes images and whole video clips (≤20 MB inline — Telegram's bot
// download cap is 20 MB anyway).
async function geminiLook(media, prompt) {
  const parts = [...media.map((m) => ({ inline_data: { mime_type: m.mime, data: m.data.toString('base64') } })), { text: prompt }];
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': keyFor('google') },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: LOOK_PROMPT }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  return ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || [])
    .map((p) => p.text).filter(Boolean).join('')).trim();
}

const PHOTO_CHAIN = [
  ['anthropic', claudeLook],
  ['openai', (imgs, p) => openaiCompatLook('openai', imgs, p)],
  ['xai', (imgs, p) => openaiCompatLook('xai', imgs, p)],
  ['google', geminiLook],
];

async function lookAtImages(images, prompt) {
  const errs = [];
  for (const [provider, fn] of PHOTO_CHAIN) {
    if (!keyFor(provider)) continue;
    try {
      const out = await fn(images, prompt);
      if (out) return out;
      errs.push(`${provider}: empty`);
    } catch (e) {
      console.error(`vision: ${provider} failed (${e.message})`);
      errs.push(e.message);
    }
  }
  throw new Error(errs.length ? `no vision model answered — ${errs.join(' | ').slice(0, 240)}` : 'no vision-capable API key on the server');
}

// --- ffmpeg fallback for video ------------------------------------------

function run(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let err = '';
    ff.stderr.on('data', (c) => { err += c; });
    ff.on('error', reject);
    ff.on('close', (code) => resolve({ code, err }));
  });
}

async function framesAndAudio(video) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgvid-'));
  try {
    const src = path.join(dir, 'in');
    fs.writeFileSync(src, video);
    const probe = await run(['-hide_banner', '-i', src]);
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.err);
    const duration = m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
    const fps = duration > 0 ? Math.min(2, MAX_FRAMES / duration) : 1;
    await run(['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `fps=${fps},scale='min(768,iw)':-2`,
      '-frames:v', String(MAX_FRAMES), '-q:v', '4', path.join(dir, 'f%02d.jpg')]);
    const frames = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort()
      .map((f) => ({ mime: 'image/jpeg', data: fs.readFileSync(path.join(dir, f)) }));
    let transcript = '';
    const audio = path.join(dir, 'a.ogg');
    const a = await run(['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', audio]);
    if (a.code === 0 && fs.existsSync(audio) && fs.statSync(audio).size > 1000) {
      transcript = await transcribe(fs.readFileSync(audio), 'audio.ogg').catch(() => '');
    }
    return { frames, transcript, duration };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- public -------------------------------------------------------------

const askLine = (caption) => (caption ? `He sent this with the message: "${caption}". Make sure the description covers whatever that asks about.` : 'He sent this with no message.');

// images: [{ mime, data: Buffer }] — one photo, or an album.
async function describePhotos(images, caption = '') {
  const lead = images.length > 1 ? `These are ${images.length} photos he sent together — describe each, numbered.` : 'Describe this photo.';
  return lookAtImages(images, `${lead} ${askLine(caption)}`);
}

async function describeVideo(video, mime = 'video/mp4', caption = '') {
  const ask = `Describe this video clip: what happens from start to finish, who/what is in it, any on-screen text, and what's said or heard (quote speech). ${askLine(caption)}`;
  if (keyFor('google')) {
    try {
      const out = await geminiLook([{ mime, data: video }], ask);
      if (out) return out;
    } catch (e) {
      console.error(`vision: gemini video failed (${e.message}) — falling back to frames`);
    }
  }
  const { frames, transcript, duration } = await framesAndAudio(video);
  if (!frames.length) throw new Error("couldn't read any frames from that video");
  const secs = duration ? `${Math.round(duration)}s clip; ` : '';
  const desc = await lookAtImages(frames,
    `These are ${frames.length} frames sampled evenly across a video (${secs}in order). ${ask}${transcript ? `\n\nAudio transcript: "${transcript}"` : '\n\n(No speech detected in the audio.)'}`);
  return transcript ? `${desc}\n\nSpoken in the clip: "${transcript}"` : desc;
}

module.exports = { describePhotos, describeVideo };
