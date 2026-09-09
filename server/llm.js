// Server-side model calls, shared by personaRuntime.js (and available to anything
// else that needs a one-shot completion off the server-held keys). Mirrors the
// provider handling in councilMeeting.js: each persona speaks on its own
// provider when that provider's key is set, and falls back to Claude on any miss.
const CLAUDE_MODEL = 'claude-sonnet-5';

const PROVIDER = {
  anthropic: { base: 'https://api.anthropic.com', env: 'ANTHROPIC_API_KEY' },
  xai: { base: 'https://api.x.ai', env: 'XAI_API_KEY' },
  openai: { base: 'https://api.openai.com', env: 'OPENAI_API_KEY' },
  google: { base: 'https://generativelanguage.googleapis.com', env: 'GEMINI_API_KEY' },
};
const keyFor = (p) => process.env[(PROVIDER[p] || {}).env];
const WEB_SEARCH_TOOL = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

// Anthropic messages call. `tools` optional (web search). `system` may be a
// string or the array form (for a cache_control prefix). Returns joined text.
async function claudeText(system, messages, { maxTokens = 900, tools, model = CLAUDE_MODEL } = {}) {
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
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
  if (api && api !== 'anthropic' && keyFor(api)) {
    try {
      if (api === 'google') {
        const out = await geminiText(model, system, msgs, maxTokens);
        if (out) return out;
      } else {
        const out = await openaiCompatText(api, model, [{ role: 'system', content: system }, ...msgs], maxTokens);
        if (out) return out;
      }
    } catch (e) {
      console.error(`llm: ${api} failed (${e.message}) — falling back to claude`);
    }
  }
  return claudeText(system, msgs, { maxTokens });
}

// Live web research — always Claude + the web_search tool.
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

module.exports = { CLAUDE_MODEL, keyFor, claudeText, openaiCompatText, geminiText, chatAs, webResearch, transcribe };
