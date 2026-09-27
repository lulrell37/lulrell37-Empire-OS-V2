// Transparent proxy to the AI providers so their keys live here, not in the APK.
//
//   ANY /ai/<provider>/<upstream path>   ->   https://<provider base>/<upstream path>
//
// The request/response bodies (including SSE streams and multipart uploads) are
// piped straight through, so the app's existing provider payloads are unchanged.
const express = require('express');
const { Readable } = require('stream');
const { claudeSubRun, subscriptionAvailable, toCliPrompt } = require('../claudeSub');

const r = express.Router();

const PROVIDERS = {
  anthropic: {
    base: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    base: 'https://api.openai.com',
    envKey: 'OPENAI_API_KEY',
    headers: (k) => ({ authorization: 'Bearer ' + k }),
  },
  xai: {
    base: 'https://api.x.ai',
    envKey: 'XAI_API_KEY',
    headers: (k) => ({ authorization: 'Bearer ' + k }),
  },
  google: {
    base: 'https://generativelanguage.googleapis.com',
    envKey: 'GEMINI_API_KEY',
    headers: (k) => ({ 'x-goog-api-key': k }),
  },
  elevenlabs: {
    base: 'https://api.elevenlabs.io',
    envKey: 'ELEVENLABS_API_KEY',
    headers: (k) => ({ 'xi-api-key': k }),
  },
};

r.all('/:provider/*', async (req, res) => {
  const p = PROVIDERS[req.params.provider];
  if (!p) return res.status(404).json({ error: 'unknown provider: ' + req.params.provider });
  const key = process.env[p.envKey];
  if (!key) return res.status(502).json({ error: `${req.params.provider} key not configured on server` });

  const upstreamPath = req.params[0] || '';
  const qs = req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?').slice(1).join('?') : '';
  const url = `${p.base}/${upstreamPath}${qs}`;

  const headers = { ...p.headers(key) };
  const ct = req.get('content-type');
  if (ct) headers['content-type'] = ct;
  const accept = req.get('accept');
  if (accept) headers.accept = accept;

  const hasBody = !['GET', 'HEAD'].includes(req.method);

  // Claude persona turns go to the Claude subscription first (CLAUDE_SUBSCRIPTION=on);
  // the metered API below only sees them when the subscription is at its usage
  // limit, can't carry the request (images), or fails before replying.
  let body = hasBody ? Readable.toWeb(req) : undefined;
  if (req.params.provider === 'anthropic' && req.method === 'POST' && upstreamPath === 'v1/messages' && subscriptionAvailable()) {
    body = await readBody(req);
    if (await trySubscription(body, req, res)) return;
  }

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
      duplex: hasBody && !Buffer.isBuffer(body) ? 'half' : undefined,
    });
    res.status(upstream.status);
    const rct = upstream.headers.get('content-type');
    if (rct) res.set('content-type', rct);
    res.set('cache-control', 'no-store');
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    console.error('ai proxy failed', req.params.provider, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'proxy failed: ' + e.message });
    else res.end();
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Answer a Messages API request from the subscription, in the same shape the
// API would (SSE events when `stream`, else a message JSON). Returns false —
// having sent nothing — when the request doesn't fit or the subscription fails
// before any text, so the caller forwards it to the metered API instead.
async function trySubscription(raw, req, res) {
  let b;
  try { b = JSON.parse(raw.toString('utf8')); } catch { return false; }
  const tools = b.tools || [];
  if (tools.some((t) => !String(t.type || '').startsWith('web_search'))) return false;
  if (!toCliPrompt(b.system, b.messages)) return false;

  const model = b.model || 'claude-sonnet-5';
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  const sse = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    sse({ type: 'message_start', message: { id: 'msg_sub', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  };
  const endStream = () => {
    sse({ type: 'content_block_stop', index: 0 });
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
    sse({ type: 'message_stop' });
    res.end();
  };
  try {
    const text = await claudeSubRun(b.system, b.messages, {
      model,
      search: tools.length > 0,
      signal: ctrl.signal,
      onText: b.stream ? (t) => { start(); sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }); } : undefined,
    });
    if (b.stream) { start(); endStream(); return true; }
    res.status(200).json({
      id: 'msg_sub', type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return true;
  } catch (e) {
    if (e.name === 'AbortError') { if (!res.headersSent) res.end(); return true; }
    if (!started) {
      console.error(`ai proxy: claude subscription failed (${e.message}) — using the metered API`);
      return false;
    }
    // Text already reached the app — close the message out rather than restart it.
    console.error(`ai proxy: claude subscription failed mid-reply (${e.message})`);
    endStream();
    return true;
  }
}

module.exports = r;
