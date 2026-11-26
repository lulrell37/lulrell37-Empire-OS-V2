// Emailed sign-in links and codes, end to end (owner, 2026-11-24: A.R.A. found five
// "Your login request to Groq" emails and could see no link — the old HTML fallback
// stripped every tag, href included). Pure parts first (no network), then
// waitForEmailAuth: the newest email from a site sent after a run reached its
// "check your email" screen, polled every 20 s for up to 10 min, giving back a code
// or the sign-in URL for the SAME browser to use. node server/scripts/test-email-links.js.

const POLL_MS = 20000;
const WAIT_MS = 10 * 60 * 1000;
const NOT_ARRIVED = 'No sign-in code or link arrived in his email within 10 minutes.';

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const unent = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
  return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
});

// Gmail's base64url -> utf8 (url-safe alphabet, padding optional).
function decodeB64Url(d) {
  const s = String(d || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64').toString('utf8');
}

// HTML -> text with every link kept: <a href=u>text</a> becomes "text (u)".
function htmlToText(html) {
  let h = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, inner) => {
    const hm = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const url = hm ? unent(hm[1] || hm[2] || hm[3] || '').trim() : '';
    const text = unent(inner.replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, ' $1 ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!/^https?:\/\//i.test(url)) return text ? ` ${text} ` : ' ';
    return ` ${text && text !== url ? text : ''} (${url}) `;
  });
  h = h.replace(/<\/(p|div|tr|li|h\d|table)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return unent(h).replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Every link in a text: [{ text, url }] (text from "text (url)" when there is one).
function extractLinks(text) {
  const out = [];
  const seen = new Set();
  const re = /(?:([^\n()]{0,80}?)\s*\()?(https?:\/\/[^\s()<>"']+)\)?/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const url = m[2].replace(/[.,;:!?]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ text: (m[1] || '').trim(), url });
  }
  return out;
}

const WANT = /log[\s_-]?in|sign[\s_-]?in|verif|confirm|magic|auth|passwordless|one[\s_-]?time|activate|continue/i;
const SKIP = /unsubscribe|opt[\s_-]?out|preferences|privacy|terms|\/track|click\.|open\.gif|pixel|beacon|mailto:|manage[\s_-]?(email|subscription)|help\.|support\.|\.(png|jpe?g|gif|svg)(\?|$)/i;
// The sign-in / verify link, or null: text or URL mentions login, sign in, verify,
// confirm or magic; unsubscribe and tracking-only links are never chosen.
function pickAuthLink(links) {
  let best = null; let bestScore = 0;
  for (const l of links || []) {
    const text = l.text || ''; const url = l.url || '';
    if (SKIP.test(url) || /unsubscribe|opt out/i.test(text)) continue;
    let s = 0;
    if (/log[\s_-]?in|sign[\s_-]?in|verif|confirm|magic/i.test(text)) s += 3;
    if (/log[\s_-]?in|sign[\s_-]?in|verif|confirm|magic|passwordless|one[\s_-]?time/i.test(url)) s += 2;
    if (WANT.test(text) || WANT.test(url)) s += 1;
    if (s > bestScore) { best = l; bestScore = s; }
  }
  return bestScore >= 2 ? best.url : null;
}

// A 4-8 digit code: next to the word "code" first, else a lone 6-8 digit number, else a lone
// 4-5 digit one that isn't a year. Digits inside URLs, #ids and $amounts are skipped.
// strict: only a number labelled as a code — used when the email also has a sign-in link,
// so a footer number (Stytch's "CA 94129" under every Groq login email, 2026-11-26)
// is never typed as a code instead of opening the link.
function extractCode(text, { strict = false } = {}) {
  const t = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  const near = /(?:code|passcode|pin|otp)\b[^\d\n]{0,40}?(?<![\d#$.])(\d{4,8})(?![\d.]\d)/i.exec(t) || /(?<![\d#$.])(\d{4,8})(?![\d.]\d)[^\n]{0,30}?\b(?:is your|code)\b/i.exec(t);
  if (near) return near[1];
  if (strict) return null;
  const six = /(?<![\d#$.,-])(\d{6,8})(?![\d,]|\.\d)/.exec(t);
  if (six) return six[1];
  for (const m of t.matchAll(/(?<![\d#$.,-])(\d{4,5})(?![\d,]|\.\d)/g)) if (!/^(19|20)\d\d$/.test(m[1])) return m[1];
  return null;
}

// Gmail search for a site's sign-in email. A site's mail often comes from its auth vendor
// (Groq -> Stytch), not its own domain, so from:(groq.com) alone misses it: also take the
// known auth senders and anything mentioning the site's name with sign-in words.
const AUTH_VENDORS = 'stytch.com OR stytch.dev OR clerk.dev OR clerk.com OR auth0.com OR workos.com OR magic.link OR firebaseapp.com OR supabase.io OR supabase.co';
const AUTH_WORDS = 'code OR verification OR verify OR "sign in" OR "log in" OR login OR confirm OR magic OR "sign-in"';
function authQuery(sender) {
  const s = String(sender || '').replace(/^from:\(|\)$/g, '').trim();
  if (!s) return `(${AUTH_WORDS})`;
  const name = (s.split(/\s+OR\s+/)[0] || '').replace(/^.*@/, '').split('.')[0].replace(/[^\w-]/g, '');
  const byName = name.length >= 3 ? ` OR (${name} (${AUTH_WORDS}))` : '';
  return `(from:(${s}) OR (from:(${AUTH_VENDORS}) (${AUTH_WORDS}))${byName})`;
}

// Newest email only: poll Gmail until one from the site, sent after `since`, holds a code or link.
// deps.list(q) -> [ids newest first]; deps.read(id) -> { id, from, subject, text, urls, internalDate }.
async function waitForEmailAuth({ sender, since = Date.now(), timeoutMs = WAIT_MS, pollMs = POLL_MS, deps, signal = null, sleep = (ms) => new Promise((r) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); r(); } if (signal) signal.addEventListener('abort', done, { once: true }); }), now = Date.now } = {}) {
  const g = deps || defaultDeps();
  const start = now();
  const after = Math.max(0, Math.floor(since / 1000) - 5);
  const q = `${authQuery(sender)} after:${after}`;
  const tried = new Set();
  for (;;) {
    if (signal && signal.aborted) return { ok: false, text: 'stopped on request', stopped: true };
    const ids = await g.list(q).catch(() => []);
    const id = ids[0]; // newest only — older links have expired
    if (id && !tried.has(id)) {
      const m = await g.read(id).catch(() => null);
      if (m && (!m.internalDate || m.internalDate >= since - 5000)) {
        const url = pickAuthLink(m.urls || extractLinks(m.text));
        const code = extractCode(`${m.subject || ''}\n${m.text || ''}`, { strict: !!url });
        if (code || url) return { ok: true, code, url, id: m.id || id, from: m.from, subject: m.subject };
        tried.add(id); // read it, nothing usable; wait for a newer one
      }
    }
    if (now() - start + pollMs > timeoutMs) return { ok: false, text: NOT_ARRIVED };
    await sleep(pollMs);
  }
}

function defaultDeps() {
  const g = require('./google');
  return {
    list: async (q) => [...String(await g.gmailList({ q, max: 3 })).matchAll(/\[id:([\w-]+)\]/g)].map((m) => m[1]),
    read: (id) => g.gmailReadParsed(id),
  };
}

// A value that is still a template placeholder is never a real answer.
const isPlaceholder = (v) => /^\s*\{\{\s*\w+\s*\}\}\s*$/.test(String(v || ''));

module.exports = { authQuery, htmlToText, extractLinks, pickAuthLink, extractCode, decodeB64Url, waitForEmailAuth, isPlaceholder, NOT_ARRIVED, POLL_MS, WAIT_MS };
