// Server-side model calls, shared by personaRuntime.js (and available to anything
// else that needs a one-shot completion off the server-held keys). Mirrors the
// provider handling in councilMeeting.js: each persona speaks on its own
// provider when that provider's key is set, and falls back to Claude on any miss.
const { claudeSubRun, subscriptionAvailable, subscriptionStatus } = require('./claudeSub');

const CLAUDE_MODEL = 'claude-sonnet-5';

const PROVIDER = {
  anthropic: { base: 'https://api.anthropic.com', env: 'ANTHROPIC_API_KEY' },
  xai: { base: 'https://api.x.ai', env: 'XAI_API_KEY' },
  openai: { base: 'https://api.openai.com', env: 'OPENAI_API_KEY' },
  google: { base: 'https://generativelanguage.googleapis.com', env: 'GEMINI_API_KEY' },
};
const keyFor = (p) => process.env[(PROVIDER[p] || {}).env];
const WEB_SEARCH_TOOL = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

// --- out-of-credit tracking -----------------------------------------------
//
// A provider whose account is out of credits (or at its spending limit) fails
// every call the same way. Remember that for a while so turns skip straight to
// the next provider instead of paying a failed round-trip each time — and so
// the user sees one clear message rather than a raw provider error.
const CREDIT_COOLDOWN_MS = 15 * 60000;
const outOfCredit = {};   // provider -> retry-after timestamp
const CREDIT_RE = {
  anthropic: /credit balance|purchase credits|billing/i,
  xai: /credits?|spending limit|licen[cs]es?|billing/i,
  openai: /insufficient_quota|exceeded your current quota|billing/i,
  google: /quota|billing/i,
};
// Anthropic's is a 400 whose text is unambiguous; the others need a 402/403/429
// status too so an ordinary error that merely mentions "billing" doesn't trip it.
const isCreditError = (provider, s) => CREDIT_RE[provider].test(String(s))
  && (provider === 'anthropic' || /\b(40[23]|429)\b/.test(String(s)));
const PROVIDER_LABEL = { anthropic: 'Anthropic API', xai: 'xAI', openai: 'OpenAI', google: 'Gemini' };
function markOutOfCredit(provider, err) {
  if (!outOfCredit[provider] || outOfCredit[provider] < Date.now()) {
    console.warn(`llm: ${provider} out of credits — skipping it for ${CREDIT_COOLDOWN_MS / 60000} min (${String(err).slice(0, 120)})`);
  }
  outOfCredit[provider] = Date.now() + CREDIT_COOLDOWN_MS;
}
const creditOk = (provider) => !!keyFor(provider) && !(outOfCredit[provider] > Date.now());
function creditStatus() {
  const now = Date.now();
  return Object.fromEntries(Object.keys(PROVIDER).map((p) => [p, outOfCredit[p] > now ? { outOfCreditUntil: outOfCredit[p] } : { ok: !!keyFor(p) }]));
}

// Anthropic messages call. `tools` optional (web search). `system` may be a
// string or the array form (for a cache_control prefix). Returns joined text.
//
// Order: Claude subscription (headless CLI, CLAUDE_SUBSCRIPTION=on) -> metered
// Anthropic API -> Grok. The subscription is skipped while it's parked on a
// usage limit (claudeSub.js resumes it at the reported reset time); the API
// and Grok are skipped while their accounts are known to be out of credits.
async function claudeText(system, messages, { maxTokens = 900, tools, model = CLAUDE_MODEL, timeoutMs } = {}) {
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
  const errs = [];
  if (subscriptionAvailable()) {
    try {
      const out = await claudeSubRun(system, msgs, { model, search: !!tools, timeoutMs });
      if (out) return out;
      errs.push('subscription: empty reply');
    } catch (e) {
      console.error(`llm: claude subscription failed (${e.message}) — using the metered API`);
      errs.push(e.message);
    }
  }
  if (creditOk('anthropic')) {
    // A 500 / 529 "overloaded" / dropped connection is Anthropic having a bad
    // second — retry it. Still failing after that, the error stands (no Grok).
    for (let attempt = 0; ; attempt++) {
      try {
        return await claudeApiText(system, msgs, { maxTokens, tools, model });
      } catch (e) {
        if (isCreditError('anthropic', e.message)) { markOutOfCredit('anthropic', e.message); errs.push(e.message); break; }
        if (!isTransient(e) || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  // Out of prepaid API credits (a claude.ai subscription doesn't fund the API):
  // answer on Grok instead of failing every persona turn, cron and search.
  if (creditOk('xai')) {
    try {
      return await grokFallback(system, msgs, { maxTokens, search: !!tools });
    } catch (e) {
      if (!isCreditError('xai', e.message)) throw e;
      markOutOfCredit('xai', e.message);
      errs.push(e.message);
    }
  }
  throw new Error(noCreditMessage(errs));
}

const isTransient = (e) => /anthropic (5\d\d|429)\b|overloaded|internal server|api_error|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|aborted|timeout/i.test(String((e && e.message) || e));

// One readable line for "every provider in the chain is out" instead of a raw
// provider JSON error.
function noCreditMessage(errs) {
  const out = Object.keys(outOfCredit).filter((p) => outOfCredit[p] > Date.now()).map((p) => PROVIDER_LABEL[p]);
  if (out.length) return `out of AI credits — ${out.join(' and ')} ${out.length > 1 ? 'are' : 'is'} empty (top up, or wait for the Claude subscription limit to reset)`;
  return `no Claude provider available${errs.length ? ` — ${errs.join(' | ').slice(0, 240)}` : ' (set ANTHROPIC_API_KEY or CLAUDE_SUBSCRIPTION)'}`;
}

async function claudeApiText(system, msgs, { maxTokens, tools, model }) {
  const body = { model, max_tokens: maxTokens, system, messages: msgs };
  if (tools) body.tools = tools;
  const res = await fetch(`${PROVIDER.anthropic.base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// Flatten Anthropic-shaped system/messages (array system with cache_control,
// content-block arrays) to plain text for xAI.
const flatText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('') : String(c || ''));

// Grok stand-in for claudeText. With `search`, runs on the Responses API with
// xAI's server-side web/X search tools; otherwise plain chat completions.
async function grokFallback(system, msgs, { maxTokens, search }) {
  const conv = [{ role: 'system', content: flatText(system) }, ...msgs.map((m) => ({ role: m.role, content: flatText(m.content) }))];
  if (!search) return openaiCompatText('xai', 'grok-4', conv, maxTokens);
  const res = await fetch(`${PROVIDER.xai.base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keyFor('xai')}` },
    body: JSON.stringify({ model: 'grok-4', max_output_tokens: Math.max(maxTokens, 1500), input: conv, tools: [{ type: 'web_search' }, { type: 'x_search' }] }),
  });
  if (!res.ok) throw new Error(`xai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return (d.output || []).filter((o) => o.type === 'message')
    .flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n').trim();
}

// Live X (Twitter) search through Grok's x_search tool. Read only: nothing here can
// post. Bills per post fetched (not de-duplicated) on top of tokens, so `maxTurns`
// caps the search rounds. X_SEARCH_MODEL overrides the model; grok-4 is the backup
// because the id is the same one the rest of this file calls.
// `web` adds live web search; `x: false` drops X, for when that's switched off.
async function xSearch(system, prompt, { days = 3, maxTurns = 8, maxTokens = 2500, web = false, x = true, timeoutMs = 180000 } = {}) {
  if (!keyFor('xai')) throw new Error('no XAI_API_KEY');
  const from = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const models = [process.env.X_SEARCH_MODEL || 'grok-4.7', 'grok-4'];
  let last;
  for (const model of [...new Set(models)]) {
    const res = await fetch(`${PROVIDER.xai.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyFor('xai')}` },
      body: JSON.stringify({
        model, max_output_tokens: maxTokens, max_turns: maxTurns,
        input: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        tools: [...(x ? [{ type: 'x_search', from_date: from }] : []), ...(web ? [{ type: 'web_search' }] : [])],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      last = new Error(`xai ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status === 400 || res.status === 404) continue; // model id gone: try the backup
      throw last;
    }
    const d = await res.json();
    const u = d.usage?.server_side_tool_usage_details || {};
    console.log(`x-search: ${model}, ${u.x_posts_fetched ?? '?'} posts, ${u.x_users_fetched ?? 0} profiles`);
    return (d.output || []).filter((o) => o.type === 'message')
      .flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n').trim();
  }
  throw last;
}

// OpenAI-compatible chat endpoint (xAI + OpenAI). `messages` is the full array
// (system message included by the caller).
async function openaiCompatText(provider, model, messages, maxTokens) {
  const tokKey = /^(gpt-5|o\d)/.test(model) ? 'max_completion_tokens' : 'max_tokens';
  const res = await fetch(`${PROVIDER[provider].base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keyFor(provider)}` },
    body: JSON.stringify({ model, [tokKey]: maxTokens, messages }),
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
}

async function geminiText(model, system, messages, maxTokens) {
  const contents = (typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages)
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  const res = await fetch(`${PROVIDER.google.base}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': keyFor('google') },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 2048) },
    }),
  });
  if (!res.ok) throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || [])
    .map((p) => p.text).filter(Boolean).join('')).trim();
}

// Speak as a persona on its real provider when that key is set; fall back to
// Claude on any miss (no key, error, empty). `system` is a string; `messages` is
// a string or a [{role,content}] array (no system entry — this adds it).
// `fallback: false` = this provider or nothing (A.R.A. is Grok only — never
// Claude); the provider's error is thrown instead.
async function chatAs(api, model, system, messages, { maxTokens = 900, fallback = true } = {}) {
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
  if (!fallback && api && api !== 'anthropic') {
    if (api === 'google') return geminiText(model, system, msgs, maxTokens);
    return openaiCompatText(api, model, [{ role: 'system', content: system }, ...msgs], maxTokens);
  }
  if (api && api !== 'anthropic' && creditOk(api)) {
    try {
      if (api === 'google') {
        const out = await geminiText(model, system, msgs, maxTokens);
        if (out) return out;
      } else {
        const out = await openaiCompatText(api, model, [{ role: 'system', content: system }, ...msgs], maxTokens);
        if (out) return out;
      }
    } catch (e) {
      if (isCreditError(api, e.message)) markOutOfCredit(api, e.message);
      console.error(`llm: ${api} failed (${e.message}) — falling back to claude`);
    }
  }
  return claudeText(system, msgs, { maxTokens });
}

// Live web research — Claude + the web_search tool (Grok search if Anthropic is out of credits).
async function webResearch(prompt) {
  return claudeText(
    `Today is ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' }).format(new Date())} ET. You are a research analyst. Search the live web and answer concisely with concrete, current facts and figures. Give the publish date of anything time-sensitive; if a source is old, say so. Cite source names inline. No preamble.`,
    prompt,
    { maxTokens: 1000, tools: WEB_SEARCH_TOOL },
  );
}

// --- speech-to-text: Groq first, OpenAI behind it -----------------------------------------------------
//
// Every Whisper call goes to Groq (whisper-large-v3-turbo, OpenAI-compatible, far cheaper) first and falls
// back to OpenAI (whisper-1) on a missing key, a file over Groq's 25 MB limit, 429 / 5xx / any other refusal,
// a timeout, or a response with no word timestamps when words were asked for. Both take the same request
// shape: response_format=verbose_json + timestamp_granularities[]=word|segment (Groq's docs say the granularities
// need verbose_json; asking for it always is valid on both, and it also returns `duration` for the usage log).
// Every call is logged (server/transcribeUsage.js). Key: GROQ_API_KEY, else app_settings.groq_api_key.
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const GROQ_MAX_BYTES = 25 * 1024 * 1024;
const GROQ_TIMEOUT_MS = 120000;
let groqPausedUntil = 0;  // after a 429 Groq is skipped until its Retry-After (rate limits are per minute / hour / day)

// A Groq key handed over by a worker or J.A.R.V.I.S. ([GROQ_KEY: gsk_…]): checked against
// Groq's /models, saved to app_settings.groq_api_key, never echoed back in full.
const GROQ_KEY_RE = /\bgsk_[A-Za-z0-9]{20,}\b/;
async function saveGroqKey(text) {
  const m = GROQ_KEY_RE.exec(String(text || ''));
  if (!m) return { ok: false, text: 'GROQ_KEY: no Groq key (gsk_…) in that' };
  const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${m[0]}` }, signal: AbortSignal.timeout(15000) }).catch((e) => ({ ok: false, status: e.message }));
  if (!r.ok) return { ok: false, text: `GROQ_KEY: Groq refused that key (${r.status}) — not saved` };
  await require('./syncStore').setSetting('groq_api_key', m[0]);
  groqPausedUntil = 0;
  return { ok: true, key: m[0], text: `GROQ_KEY: ✓ saved (${m[0].slice(0, 8)}…) — transcription (Telegram voice notes, the app's mic, clips) now goes to Groq first, OpenAI only as the backup` };
}
async function groqKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  try { return String(await require('./syncStore').getSetting('groq_api_key', '') || '').trim(); } catch { return ''; }
}

// fields: [[name, value]...] (model is added per provider). Returns { data, provider }. Throws only when OpenAI
// (the last resort) fails too, or when there is no OpenAI key to fall back to.
async function stt(buffer, filename, fields, { job = 'other', words = false } = {}) {
  const usage = require('./transcribeUsage');
  const form = (model) => {
    const f = new FormData();
    f.append('file', new Blob([buffer]), filename);
    f.append('model', model);
    f.append('response_format', 'verbose_json');
    for (const [k, v] of fields) f.append(k, v);
    return f;
  };
  const log = (provider, data, fallback, why) => usage.record({
    provider, fallback, why, job, bytes: buffer.length,
    sec: Number(data && data.duration) || (data && (data.segments || []).length ? Number(data.segments[data.segments.length - 1].end) || 0 : 0),
  });
  let why = '';
  const key = await groqKey();
  if (!key) why = 'no Groq key';
  else if (buffer.length > GROQ_MAX_BYTES) why = 'over Groq 25 MB limit';
  else if (groqPausedUntil > Date.now()) why = 'Groq rate-limited (paused)';
  else {
    try {
      const res = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form(GROQ_MODEL), signal: AbortSignal.timeout(GROQ_TIMEOUT_MS) });
      if (res.ok) {
        const data = await res.json();
        if (words && !(data.words || []).length && String(data.text || '').trim()) why = 'Groq returned no word timestamps';
        else { log('groq', data, false, ''); return { data, provider: 'groq' }; }
      } else {
        if (res.status === 429) {
          const wait = Math.min(Math.max(parseFloat(res.headers.get('retry-after')) || 60, 5), 600);
          groqPausedUntil = Date.now() + wait * 1000;
        }
        why = `Groq ${res.status}`;
      }
    } catch (e) { why = /timeout|abort/i.test(`${e.name} ${e.message}`) ? 'Groq timeout' : `Groq error: ${String(e.message).slice(0, 60)}`; }
  }
  if (!process.env.OPENAI_API_KEY) throw new Error(`transcription needs OPENAI_API_KEY on the server (Groq unavailable: ${why})`);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form('whisper-1'),
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  log('openai', data, true, why);
  return { data, provider: 'openai' };
}

// Transcribe an audio buffer (a Telegram voice note is OGG/Opus) with Whisper. Returns the text, or throws.
async function transcribe(buffer, filename = 'voice.ogg', { job = 'voice note' } = {}) {
  // The persona names as vocabulary, so "Ara" isn't heard as "Aura".
  const { data } = await stt(buffer, filename, [
    ['language', 'en'],
    ['prompt', 'A.R.A., Ara, J.A.R.V.I.S., T.A.L.O.N., S.E.L.E.N.E., A.I.S.H.A., H.A.V.E.N. Okay. Here is what I need you to do.'],
  ], { job });
  return fixNames(data.text || '');
}

// Whisper refuses audio under 0.1 s (audio_too_short) and that used to abort a whole scan. A stub like that
// is a tiny file with no audio frames: anything under 1 KB can't hold 0.1 s of speech, so treat it as silence.
const tooShort = (buf) => !buf || buf.length < 1024;

// Whisper with timestamps: [{ start, end, text }] in seconds, for a long
// recording's chunk. Same persona-name vocabulary.
async function transcribeSegments(buffer, filename = 'audio.mp3', { prompt = 'A.R.A., Ara, J.A.R.V.I.S., T.A.L.O.N., S.E.L.E.N.E. Okay. Here is what I need you to do.', job = 'other' } = {}) {
  if (tooShort(buffer)) return [];
  const fields = [];
  if (prompt) fields.push(['prompt', prompt]);
  const ownVoice = !!prompt && /J\.A\.R\.V\.I\.S/.test(prompt);
  const { data: d } = await stt(buffer, filename, fields, { job });
  return (d.segments || []).map((s) => ({ start: s.start, end: s.end, text: ownVoice ? fixNames(s.text) : String(s.text || '').trim() })).filter((s) => s.text);
}

// Speech-to-text keeps hearing "Ara" as "Aura" — he never means aura.
// Mirrors fixNames in src/services/aiService.js.
function fixNames(text) {
  return String(text || '').replace(/\baura(?=\b|'s)/gi, 'Ara').trim();
}

// Word-level timestamps for a short piece of audio (clip captions): [{ word, start, end }].
// `prompt` is what was said around it (from the full transcript), so names and
// slang come out spelled the same way. Words inside a segment Whisper itself
// flags as probably invented (no speech + low confidence, or a looping
// repetition) are dropped: that is what put words on screen nobody said.
async function transcribeWords(buffer, filename = 'clip.mp3', { prompt = '', job = 'clip captions' } = {}) {
  if (tooShort(buffer)) return [];
  const fields = [['timestamp_granularities[]', 'word'], ['timestamp_granularities[]', 'segment'], ['temperature', '0']];
  if (prompt) fields.push(['prompt', String(prompt).slice(-800)]);
  const { data: d } = await stt(buffer, filename, fields, { job, words: true });
  const bad = (d.segments || []).filter((s) => (s.no_speech_prob > 0.6 && s.avg_logprob < -0.8) || s.compression_ratio > 2.4 || s.avg_logprob < -1.2);
  return (d.words || []).map((w) => ({ word: String(w.word || '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start) && !bad.some((s) => w.start >= s.start - 0.05 && w.end <= s.end + 0.05));
}

module.exports = { saveGroqKey, GROQ_KEY_RE, stt, GROQ_URL, GROQ_MODEL, GROQ_MAX_BYTES, _resetGroqPause: () => { groqPausedUntil = 0; }, transcribeWords, CLAUDE_MODEL, keyFor, WEB_SEARCH_TOOL, claudeText, creditStatus, subscriptionStatus, openaiCompatText, geminiText, chatAs, webResearch, xSearch, transcribe, transcribeSegments, fixNames };
