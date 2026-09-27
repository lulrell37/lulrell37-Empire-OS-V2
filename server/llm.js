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
async function claudeText(system, messages, { maxTokens = 900, tools, model = CLAUDE_MODEL } = {}) {
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
  const errs = [];
  if (subscriptionAvailable()) {
    try {
      const out = await claudeSubRun(system, msgs, { model, search: !!tools });
      if (out) return out;
      errs.push('subscription: empty reply');
    } catch (e) {
      console.error(`llm: claude subscription failed (${e.message}) — using the metered API`);
      errs.push(e.message);
    }
  }
  if (creditOk('anthropic')) {
    try {
      return await claudeApiText(system, msgs, { maxTokens, tools, model });
    } catch (e) {
      if (!isCreditError('anthropic', e.message)) throw e;
      markOutOfCredit('anthropic', e.message);
      errs.push(e.message);
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
async function chatAs(api, model, system, messages, { maxTokens = 900 } = {}) {
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
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
    'You are a research analyst. Search the live web and answer concisely with concrete, current facts and figures. Cite source names inline. No preamble.',
    prompt,
    { maxTokens: 1000, tools: WEB_SEARCH_TOOL },
  );
}

// Transcribe an audio buffer (a Telegram voice note is OGG/Opus) with Whisper.
// Needs OPENAI_API_KEY. Returns the text, or throws.
async function transcribe(buffer, filename = 'voice.ogg') {
  if (!process.env.OPENAI_API_KEY) throw new Error('voice input needs OPENAI_API_KEY on the server');
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('prompt', 'Okay. Here is what I need you to do.');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  return (d.text || '').trim();
}

module.exports = { CLAUDE_MODEL, keyFor, claudeText, creditStatus, subscriptionStatus, openaiCompatText, geminiText, chatAs, webResearch, transcribe };
