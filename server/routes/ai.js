// Transparent proxy to the AI providers so their keys live here, not in the APK.
//
//   ANY /ai/<provider>/<upstream path>   ->   https://<provider base>/<upstream path>
//
// The request/response bodies (including SSE streams and multipart uploads) are
// piped straight through, so the app's existing provider payloads are unchanged.
const express = require('express');
const { Readable } = require('stream');

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

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
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

module.exports = r;
