// Transparent proxy to the AI providers so their keys live here, not in the APK.
//
//   ANY /ai/<provider>/<upstream path>   ->   https://<provider base>/<upstream path>
//
// The request/response bodies (including SSE streams and multipart uploads) are
// piped straight through, so the app's existing provider payloads are unchanged.
const express = require('express');
const { Readable } = require('stream');
const { claudeSubRun, subscriptionAvailable, toCliPrompt } = require('../claudeSub');
const serverLog = require('../serverLog');

const r = express.Router();

// Replit's edge gives up on an app request at ~300s and answers it with its own
// 408. A subscription try that timed out (up to 240s) plus a metered fallback
// with retries used to run past that, so the whole Claude call now lives inside
// one budget: the subscription gets a slice, the API gets what's left, and a
// call that still runs out comes back as a clean Anthropic-shaped error.
const CLAUDE_BUDGET_MS = 280000;
const SUB_BUDGET_MS = { plain: 90000, search: 150000 };

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

// The app's microphone (transcribeAudio in src/services/aiService.js) posts OpenAI's
// whisper-1 here. Groq hosts the same Whisper for free, so that one request goes to
// Groq first (model swapped to whisper-large-v3-turbo inside the multipart body) and
// only falls through to OpenAI when Groq has no key, refuses or times out — no APK
// needed (owner, 2026-11-26: "replace whisper with groq so I can talk again").
const GROQ_STT = 'https://api.groq.com/openai/v1/audio/transcriptions';
function swapModel(buf) {
  const s = buf.toString('latin1');
  const out = s.replace(/(name="model"\r\n(?:[^\r\n]*\r\n)*\r\n)whisper-1(\r\n)/, '$1whisper-large-v3-turbo$2');
  return out === s ? null : Buffer.from(out, 'latin1');
}
async function groqFirst(req, res) {
  const key = process.env.GROQ_API_KEY || String(await require('../syncStore').getSetting('groq_api_key', '').catch(() => '') || '').trim();
  const body = await readBody(req);
  if (key && body.length <= 25 * 1024 * 1024) {
    const swapped = swapModel(body);
    if (swapped) {
      try {
        const g = await fetch(GROQ_STT, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': req.get('content-type') }, body: swapped, signal: AbortSignal.timeout(60000) });
        const text = await g.text();
        if (g.ok) {
          serverLog.recordAi({ provider: 'groq', method: 'POST', path: 'v1/audio/transcriptions', ok: true, status: 200, bytes: body.length, ms: 0 });
          try { require('../transcribeUsage').record({ provider: 'groq', fallback: false, why: '', job: 'app voice', bytes: body.length, sec: 0 }); } catch {}
          return res.status(200).set('content-type', 'application/json').send(text);
        }
        console.warn(`ai proxy: groq ${g.status} on app voice, falling back to OpenAI: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
      } catch (e) { console.warn(`ai proxy: groq failed on app voice, falling back to OpenAI: ${e.message}`); }
    }
  }
  return body; // the caller sends it on to OpenAI
}

r.all('/:provider/*', async (req, res) => {
  let sttBody = null;
  if (req.params.provider === 'openai' && req.method === 'POST' && req.params[0] === 'v1/audio/transcriptions') {
    sttBody = await groqFirst(req, res);
    if (res.headersSent) return;
  }
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
  const claudeCall = req.params.provider === 'anthropic' && req.method === 'POST';
  // Grok / OpenAI chat turns: a reasoning model can think in silence long enough
  // for Replit's edge to drop the request ("Internal Server Error" on the phone),
  // so they get the same keep-alive as Claude. Audio, uploads etc. stay piped.
  const chatCall = req.method === 'POST' && ['xai', 'openai'].includes(req.params.provider)
    && /^v1\/(chat\/completions|responses)$/.test(upstreamPath);
  const holdBody = claudeCall || chatCall;
  // Only ONE reader may consume the request. The old code always opened a web
  // stream on it and then, for Claude, read it again with readBody — any body
  // over ~64 KB (every real app turn) never finished, so Claude calls hung until
  // the edge answered 408 / "Internal server error".
  let body = sttBody || (hasBody && !holdBody ? Readable.toWeb(req) : undefined);
  const t0 = Date.now();
  let stopKeepAlive = () => {};
  const rec = { provider: req.params.provider, method: req.method, path: upstreamPath, ua: req.get('user-agent') || '', bytes: Number(req.get('content-length')) || null };
  let recorded = false;
  const record = (ok, status, detail) => {
    if (recorded) return;
    recorded = true;
    serverLog.recordAi({ ...rec, ok, status, detail: detail ? String(detail).replace(/\s+/g, ' ').slice(0, 300) : '', ms: Date.now() - t0 });
  };
  res.on('close', () => { if (!recorded) record(res.statusCode < 400 && res.writableFinished, res.writableFinished ? res.statusCode : `${res.statusCode} (closed early — app hung up or edge cut it)`); });

  try {
    // Anthropic having a bad second (500 / 529 overloaded / 503) used to land on
    // the phone as "Claude error: Internal server error" and kill the turn. Hold
    // the body so the call can be retried — nothing has gone back to the app yet.
    if (holdBody) {
      body = await readBody(req);
      rec.uploadMs = Date.now() - t0;
      rec.bytes = body.length;
      let streaming = false;
      try { const j = JSON.parse(body.toString('utf8')); streaming = !!j.stream; rec.model = j.model; rec.stream = streaming; } catch {}
      stopKeepAlive = streaming ? keepAliveSse(res) : keepAlive(res);
    }

    if (claudeCall && upstreamPath === 'v1/messages' && subscriptionAvailable()) {
      if (await trySubscription(body, req, res)) return;
    }
    const deadline = t0 + CLAUDE_BUDGET_MS;

    let upstream;
    let netErr = null;
    for (let attempt = 0; ; attempt++) {
      // Only Claude calls get the deadline; it covers waiting for the reply to
      // start, not a stream that's already flowing back to the app.
      const ctrl = claudeCall ? new AbortController() : null;
      const left = claudeCall ? deadline - Date.now() : 0;
      if (claudeCall && left <= 0) throw Object.assign(new Error('out of time'), { name: 'BudgetError' });
      const timer = ctrl && setTimeout(() => ctrl.abort(), left);
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body,
        signal: ctrl ? ctrl.signal : undefined,
        duplex: hasBody && !Buffer.isBuffer(body) ? 'half' : undefined,
      }).catch((e) => {
        if (ctrl && ctrl.signal.aborted) throw Object.assign(new Error('out of time'), { name: 'BudgetError' });
        if (!claudeCall || attempt >= 3) throw e;
        netErr = e;
        return null;
      }).finally(() => clearTimeout(timer));
      const retry = claudeCall && attempt < 3 && (!upstream || upstream.status >= 500)
        && deadline - Date.now() > 30000;
      if (!retry) { if (!upstream) throw netErr; break; }
      console.warn(`ai proxy: anthropic ${upstream ? upstream.status : 'network error'} — retry ${attempt + 1}/3`);
      if (upstream && upstream.body) await upstream.body.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    stopKeepAlive();
    if (!upstream.ok) {
      // Keep what the provider said: it's the evidence [AI_ERRORS] shows.
      const raw = await upstream.text().catch(() => '');
      record(false, upstream.status, raw || '(empty body)');
      console.warn(`ai proxy: ${req.params.provider} ${upstream.status} on /${upstreamPath}: ${raw.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (res.headersSent && isSse(res)) {
        // The stream is already open — hand the API's error over as an SSE event.
        let err; try { err = JSON.parse(raw); } catch { err = { type: 'error', error: { type: 'api_error', message: `${req.params.provider} ${upstream.status}: ${raw.slice(0, 200)}` } }; }
        if (err && !err.type) err = { type: 'error', error: { type: 'api_error', message: `${req.params.provider} ${upstream.status}: ${String(err.error || err.message || raw).slice(0, 200)}` } };
        return sendJson(res, upstream.status, err);
      }
      if (!res.headersSent) {
        res.status(upstream.status).set('cache-control', 'no-store');
        const rct = upstream.headers.get('content-type');
        if (rct) res.set('content-type', rct);
      }
      return res.end(raw);
    }
    if (!res.headersSent) {
      res.status(upstream.status);
      const rct = upstream.headers.get('content-type');
      if (rct) res.set('content-type', rct);
      res.set('cache-control', 'no-store');
    }
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    // The app hung up mid-upload: nobody is left to answer. Before this sat
    // inside the try, that rejection went unhandled and took the whole server
    // down (every persona then got "Internal server error" while it restarted).
    stopKeepAlive();
    const secs = Math.round((Date.now() - t0) / 1000);
    record(false, e.name === 'BudgetError' ? 504 : req.aborted ? 'app hung up' : 502, e.message);
    if (req.aborted || e.message === 'aborted') return console.warn(`ai proxy: app closed the request after ${secs}s`, req.params.provider);
    if (e.name === 'BudgetError') {
      console.error(`ai proxy: claude ran out of time after ${secs}s`);
      return sendJson(res, 504, { type: 'error', error: { type: 'timeout_error', message: `Claude took too long (${secs}s) — try again` } });
    }
    console.error(`ai proxy failed after ${secs}s`, req.params.provider, e.message);
    sendJson(res, 502, { type: 'error', error: { type: 'proxy_error', message: 'proxy failed: ' + e.message } });
  }
});

// A non-streaming Claude call sends nothing until the whole reply exists — the
// subscription CLI alone can take minutes — and Replit's edge drops a silent
// request, answering the app with its own "Internal server error". After 10s
// of silence, commit a 200 and trickle spaces (leading whitespace is still
// valid JSON) so the connection stays open; an error that comes after that
// goes out as an Anthropic-shaped error body instead of a status code.
function keepAlive(res) {
  let iv = null;
  const t = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    res.status(200).set({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.write(' ');
    iv = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 10000);
  }, 10000);
  const stop = () => { clearTimeout(t); if (iv) clearInterval(iv); };
  res.on('close', stop);
  return stop;
}

// The streaming twin of keepAlive: a streamed reply from the subscription sends
// nothing until its first word, and the edge cut that silence off with a 408
// (the app's "HTTP 408"). After 5s, commit the SSE stream and send Anthropic's
// own `ping` event every 10s — the app already skips pings — until real events
// flow. A late error then goes out as an SSE `error` event.
function keepAliveSse(res) {
  let iv = null;
  const ping = () => { if (!res.writableEnded) res.write('event: ping\ndata: {"type": "ping"}\n\n'); };
  const t = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    ping();
    iv = setInterval(ping, 10000);
  }, 5000);
  const stop = () => { clearTimeout(t); if (iv) clearInterval(iv); };
  res.on('close', stop);
  return stop;
}

const isSse = (res) => /event-stream/.test(String(res.get('content-type') || ''));

// res.status().json(), or — once a keep-alive has already sent the headers —
// the same body written onto the open response (as an SSE event on a stream).
function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  if (!res.headersSent) return res.status(status).json(obj);
  if (isSse(res)) return res.end(`event: ${obj.type || 'message'}\ndata: ${JSON.stringify(obj)}\n\n`);
  res.end(JSON.stringify(obj));
}

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
    if (!res.headersSent) res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
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
      timeoutMs: tools.length > 0 ? SUB_BUDGET_MS.search : SUB_BUDGET_MS.plain,
      signal: ctrl.signal,
      onText: b.stream ? (t) => { start(); sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }); } : undefined,
    });
    if (b.stream) { start(); endStream(); return true; }
    sendJson(res, 200, {
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

r._swapModel = swapModel;
module.exports = r;
