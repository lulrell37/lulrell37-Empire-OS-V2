// The website desk: S.C.O.U.T. finds local businesses on Google Maps, J.A.R.V.I.S.
// builds each one a new website (S.E.L.E.N.E.'s design direction, S.C.R.I.B.E.'s
// copy), it's hosted on this server at /sites/<slug>, and S.C.O.U.T. emails the
// owner the link with the offer. Owner's call, 2026-11-21.
//   - finding: Google Places text search (GOOGLE_PLACES_API_KEY or
//     GOOGLE_MAPS_API_KEY) for real listings: phone, address, hours, rating,
//     reviews and photos. Without a key it falls back to a web search, and says so.
//   - a business with a site gets that site as the template, made better and
//     modern (its own text, images, logo and colors); one without gets its first
//   - every site needs an email to send it to (the old site's, or a search);
//     no email, no build
//   - SITES_PER_DAY (setting site_desk_per_day, default 3), 9 AM-6 PM ET
//   - the first REVIEW_FIRST (3) wait for his OK: A.R.A. sends him the link and
//     nothing goes out until he says approve ([SITE_APPROVE]), change it
//     ([SITE_REVISE]) or drop it ([SITE_DROP]). After those, each site is
//     emailed as soon as it's built and he's sent the link.
//   - no made-up facts: copy, reviews and claims come only from the listing and
//     the old site; every page is noindex and says it's a preview
// Tags: [SITE_DESK] (status, or "run"), [SITE_APPROVE: name], [SITE_REVISE:
// name | changes], [SITE_DROP: name], [SITE_OFFER: text] (J.A.R.V.I.S., A.R.A.,
// S.C.O.U.T.). SITE_DESK=off stops it. Pages: table demo_sites. State:
// app_settings.site_desk. node server/scripts/test-site-desk.js.
const crypto = require('crypto');
const { query } = require('./db');
const { getSetting, setSetting, todayET } = require('./syncStore');
const { claudeText, webResearch, CLAUDE_MODEL } = require('./llm');
const { pickTarget } = require('./scoutTargets');

const KEY = 'site_desk';
const REVIEW_FIRST = 3;
const MAX_WAITING = 3;
const MODEL = process.env.SITE_DESK_MODEL || CLAUDE_MODEL;
const DEFAULT_OFFER = 'Because we built this for you before you asked, you get our early-bird rate: $497 to put it live on your own domain (normally $995), then $347 a month for hosting, updates, changes whenever you need them, and your Google Business Profile kept up to date.';
const LIVE_URL = 'https://lulrell-37-empire-os-v-2--lulrell37.replit.app';

// Businesses that live on how they look and get found locally.
const SEGMENTS = [
  'barbershop', 'hair salon', 'nail salon', 'restaurant', 'cafe', 'bakery', 'food truck', 'auto repair shop',
  'auto detailing', 'landscaping and lawn care', 'house cleaning service', 'plumber', 'electrician', 'HVAC contractor',
  'roofing contractor', 'painting contractor', 'handyman', 'pressure washing', 'junk removal', 'moving company',
  'tattoo shop', 'personal trainer gym', 'martial arts studio', 'dance studio', 'daycare', 'dog grooming',
  'photographer', 'florist', 'tailor and alterations', 'boutique clothing store', 'tax preparation', 'event venue',
];

const enabled = () => String(process.env.SITE_DESK || '').toLowerCase() !== 'off';
const placesKey = () => process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
const baseUrl = () => (require('./redeploy').publicUrl() || LIVE_URL);
const siteUrl = (slug) => `${baseUrl()}/sites/${slug}`;
const hourET = () => Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })) % 24;

async function load() {
  const raw = await getSetting(KEY, '{}').catch(() => '{}');
  let s; try { s = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw; } catch { s = {}; }
  return { day: '', builtToday: 0, reviewLeft: REVIEW_FIRST, cursor: 0, seen: [], offer: '', ...(s || {}) };
}
const save = (s) => setSetting(KEY, JSON.stringify({ ...s, seen: (s.seen || []).slice(-400) }));

// --- the pages ---------------------------------------------------------------

async function allSites() {
  const r = await query('SELECT slug, data, created_at FROM demo_sites ORDER BY created_at DESC LIMIT 200');
  return r.rows.map((x) => ({ slug: x.slug, created_at: Number(x.created_at), ...(x.data || {}) }));
}
async function getHtml(slug) {
  const r = await query('SELECT html, data FROM demo_sites WHERE slug = $1', [String(slug || '')]);
  const row = r.rows[0];
  if (!row || (row.data && row.data.status === 'dropped')) return null;
  return row.html;
}
async function putSite(slug, data, html) {
  const now = Date.now();
  await query(`INSERT INTO demo_sites (slug, data, html, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)
    ON CONFLICT (slug) DO UPDATE SET data = EXCLUDED.data, html = COALESCE(EXCLUDED.html, demo_sites.html), updated_at = EXCLUDED.updated_at`,
  [slug, data, html, now]);
}

function slugFor(name) {
  const base = String(name || 'site').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

// --- pure helpers (tested) ---------------------------------------------------

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hostOf = (s) => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
const FREE_MAIL = /@(gmail|yahoo|outlook|hotmail|aol|icloud|me|live|msn|comcast|verizon|att|sbcglobal|ymail|protonmail)\.(com|net)$/i;
const JUNK_MAIL = /(example|domain|email|yourname|sentry|wixpress|godaddy|squarespace|schema|png|jpg|jpeg|gif|webp|svg)\b|^(noreply|no-reply|donotreply)@/i;

// Emails worth writing to: on the business's own domain, or a free mailbox.
function pickEmail(text, website = '') {
  const host = hostOf(website).replace(/^[^.]+\.(?=[^.]+\.[^.]+$)/, '');
  const found = [...new Set((String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase().replace(/\.$/, '')))]
    .filter((e) => !JUNK_MAIL.test(e));
  const own = found.filter((e) => host && e.endsWith(`@${host}`) || (host && e.split('@')[1].endsWith(`.${host}`)));
  return own[0] || found.find((e) => FREE_MAIL.test(e)) || '';
}

const abs = (u, base) => { try { return new URL(String(u).trim(), base).href; } catch { return ''; } };
const strip = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// What an old site gives the new one: its words, images, logo, colors, links.
function readOldSite(html, url) {
  const h = String(html || '');
  const meta = (n) => ((new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]+content=["']([^"']+)`, 'i').exec(h)) || [])[1] || '';
  const imgs = [];
  const push = (src, alt = '') => {
    const u = abs(String(src).split(/\s+/)[0], url);
    if (!/^https?:/i.test(u) || /\.svg(\?|$)|pixel|1x1|spacer|blank\.|favicon|tracking|facebook\.com\/tr|gravatar/i.test(u)) return;
    if (!imgs.some((i) => i.url === u)) imgs.push({ url: u, alt: String(alt).slice(0, 80) });
  };
  const og = meta('og:image'); if (og) push(og, 'og image');
  for (const m of h.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (/(?:data-src|data-lazy-src|src)=["']([^"']+)/i.exec(tag) || [])[1] || (/srcset=["']([^"']+)/i.exec(tag) || [])[1];
    if (src && !/^data:/i.test(src)) push(src, (/alt=["']([^"']*)/i.exec(tag) || [])[1] || '');
  }
  for (const m of h.matchAll(/background(?:-image)?\s*:\s*url\(["']?([^"')]+)/gi)) if (!/^data:/i.test(m[1])) push(m[1], 'background');
  const logo = (imgs.find((i) => /logo/i.test(i.url) || /logo/i.test(i.alt)) || {}).url || '';
  const counts = {};
  for (const m of h.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const c = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
    const k = `#${c.toLowerCase()}`;
    if (!/^#(ffffff|000000)$/.test(k)) counts[k] = (counts[k] || 0) + 1;
  }
  const colors = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);
  const socials = [...new Set((h.match(/https?:\/\/(?:www\.)?(?:facebook|instagram|tiktok|youtube|x|twitter|yelp|linkedin)\.com\/[^"'\s<>)]+/gi) || []))].slice(0, 6);
  const links = [...new Set([...h.matchAll(/<a\b[^>]+href=["']([^"'#]+)["']/gi)].map((m) => abs(m[1], url)).filter((u) => hostOf(u) === hostOf(url)))];
  return {
    title: strip((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1] || '').slice(0, 160),
    description: meta('description') || meta('og:description'),
    text: strip(h).slice(0, 6000),
    images: imgs.slice(0, 14),
    logo, colors, socials, links,
    email: pickEmail(`${h} ${strip(h)}`, url),
    builder: (/wix|squarespace|godaddy|weebly|wordpress|shopify|duda|jimdo/i.exec(h) || [])[0] || '',
    copyrightYear: Number(((/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/i.exec(h)) || [])[1]) || null,
  };
}

// A model's HTML -> a page we'll serve: no outside scripts, no forms that post
// nowhere, real images only, noindex, and a line saying it's a preview.
function finishHtml(raw, { name, images = [] } = {}) {
  let h = String(raw || '');
  const a = h.search(/<!doctype html|<html/i);
  const z = h.toLowerCase().lastIndexOf('</html>');
  if (a < 0 || z < 0) throw new Error('no complete HTML page in the reply');
  h = h.slice(a, z + 7);
  h = h.replace(/GEN:([^"')]+)/g, (_, p) => genImage(p));
  h = h.replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/gi, '');
  h = h.replace(/<form\b[^>]*>/gi, '<form onsubmit="return false">');
  const allowed = new Set(images.map((i) => i.url));
  h = h.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (m, pre, src, post) =>
    (allowed.has(src) || /^https:\/\/image\.pollinations\.ai\//.test(src) || /^data:image\/svg/.test(src) ? m : `${pre}${genImage(`${name} storefront, warm natural light, professional photo`)}${post}`));
  const head = '<meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1">';
  h = /<head[^>]*>/i.test(h) ? h.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : h.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  const ribbon = `<div id="empire-preview" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(10,10,10,.88);color:#eee;font:13px/1.4 system-ui,sans-serif;text-align:center;padding:7px 12px">Preview: a new website concept made for ${esc(name)} by Empire Digital. Not yet the official site.</div>`;
  h = h.replace(/<\/body>/i, `${ribbon}</body>`);
  return h;
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function genImage(prompt) {
  const p = String(prompt || '').replace(/["'<>]/g, '').trim().slice(0, 300);
  const seed = parseInt(crypto.createHash('md5').update(p).digest('hex').slice(0, 6), 16);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=1600&height=1000&nologo=true&seed=${seed}`;
}

// The checks a page must pass before anyone sees it.
function checkHtml(h, biz) {
  const bad = [];
  if (h.length < 4000) bad.push('page is too short to be a real site');
  if (/lorem ipsum|example\.com|\(555\)|555-\d{4}|\[(your|insert|business)/i.test(h)) bad.push('placeholder text left in');
  const digits = String(biz.phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length === 10 && !h.replace(/\D/g, '').includes(digits)) bad.push(`the real phone number (${biz.phone}) is missing`);
  const first = normName(String(biz.name).split(/\s+/)[0]);
  if (first && !normName(strip(h).replace(/&#0?39;|&apos;/g, "'")).includes(first)) bad.push('the business name is missing');
  return bad;
}

// --- finding (Google Maps) ---------------------------------------------------

const FIELDS = ['id', 'displayName', 'formattedAddress', 'nationalPhoneNumber', 'websiteUri', 'rating', 'userRatingCount', 'reviews',
  'photos', 'businessStatus', 'primaryTypeDisplayName', 'regularOpeningHours.weekdayDescriptions', 'googleMapsUri'].map((f) => `places.${f}`).join(',');

async function placesSearch(text) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': placesKey(), 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({ textQuery: text, maxResultCount: 20 }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`google places ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return (d.places || []).filter((p) => !p.businessStatus || p.businessStatus === 'OPERATIONAL').map((p) => ({
    placeId: p.id,
    name: (p.displayName && p.displayName.text) || '',
    address: p.formattedAddress || '',
    phone: p.nationalPhoneNumber || '',
    website: p.websiteUri || '',
    rating: p.rating || null,
    ratings: p.userRatingCount || 0,
    type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '',
    hours: ((p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions) || []).join('; '),
    maps: p.googleMapsUri || '',
    reviews: (p.reviews || []).filter((r) => (r.rating || 0) >= 4 && r.text && r.text.text).slice(0, 5)
      .map((r) => ({ author: (r.authorAttribution && r.authorAttribution.displayName) || '', rating: r.rating, text: r.text.text.slice(0, 400) })),
    photoNames: (p.photos || []).slice(0, 6).map((x) => x.name),
  }));
}

async function placePhotos(names = []) {
  const out = [];
  for (const n of names) {
    try {
      const r = await fetch(`https://places.googleapis.com/v1/${n}/media?maxWidthPx=1600&skipHttpRedirect=true&key=${placesKey()}`, { signal: AbortSignal.timeout(15000) });
      const d = r.ok ? await r.json() : {};
      if (d.photoUri) out.push({ url: d.photoUri, alt: 'Google Maps photo of the business' });
    } catch {}
  }
  return out;
}

// Without a Places key: the same kind of list off a web search.
async function webSearchBusinesses(segment, metro) {
  const raw = await webResearch(`Find small, independent, currently open ${segment} businesses in ${metro} from their Google Maps / Google Business listings. For each give: exact business name, full address, phone number, website URL (or "none" if they have no website), Google rating and review count. Only real listings you found, never chains or franchises.`);
  const resp = await claudeText('Turn search results into JSON. Never invent a field; leave it empty if the results don\'t give it.', [{ role: 'user', content:
    `${String(raw).slice(0, 6000)}\n\nReturn ONLY a JSON array: [{"name":"","address":"","phone":"","website":"","rating":null,"ratings":0}]. website is "" when they have none.` }], { maxTokens: 1500 });
  const m = /\[[\s\S]*\]/.exec(resp || '');
  let list = []; try { list = JSON.parse(m ? m[0] : '[]'); } catch {}
  return list.filter((b) => b && b.name).map((b) => ({ ...b, website: /^https?:/i.test(b.website || '') ? b.website : '', reviews: [], photoNames: [], type: segment }));
}

const CHAIN = /\b(mcdonald|starbucks|subway|great clips|supercuts|sport clips|jiffy lube|midas|meineke|valvoline|firestone|pep boys|h&r block|jackson hewitt|liberty tax|two men and a truck|1-800|molly maid|merry maids|servpro|roto-rooter|mr\. rooter|orangetheory|planet fitness|anytime fitness|chick-fil-a|domino|pizza hut|dunkin|state farm|allstate|regis|ulta|massage envy|european wax)\b/i;

// Which of a search's businesses to build for. No site, or a dated one, first;
// real listings only (some reviews), no chains, nobody we've already done.
const NOT_A_SITE = /facebook\.com|instagram\.com|yelp\.com|linktr\.ee|square\.site|booksy|vagaro|styleseat|google\.com|business\.site/i;
function rankCandidates(list, seen = []) {
  const done = new Set(seen);
  return list
    .map((b) => (b.website && NOT_A_SITE.test(b.website) ? { ...b, social: b.website, website: '' } : b))
    .filter((b) => b.name && !CHAIN.test(b.name) && !done.has(normName(b.name)) && !(b.website && done.has(hostOf(b.website)))
      && (b.ratings == null || b.ratings === 0 && !b.placeId || b.ratings >= 5))
    .sort((a, b) => (a.website ? 1 : 0) - (b.website ? 1 : 0) || (b.ratings || 0) - (a.ratings || 0));
}

async function fetchPage(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' } });
  if (!res.ok) throw new Error(`${res.status}`);
  return { html: (await res.text()).slice(0, 600000), url: res.url || url };
}

// The old site (homepage + its about/services/contact pages), if there is one.
async function gatherOld(website) {
  if (!website) return null;
  let home;
  try { home = await fetchPage(website); } catch { return null; }
  const old = readOldSite(home.html, home.url);
  const extra = old.links.filter((u) => /about|service|menu|contact|gallery|pricing|team/i.test(u)).slice(0, 3);
  for (const u of extra) {
    try {
      const p = await fetchPage(u);
      const r = readOldSite(p.html, p.url);
      old.text += `\n\n[${u}] ${r.text.slice(0, 2500)}`;
      for (const i of r.images) if (old.images.length < 18 && !old.images.some((x) => x.url === i.url)) old.images.push(i);
      if (!old.email) old.email = r.email;
    } catch {}
  }
  old.url = home.url;
  return old;
}

async function findEmail(biz) {
  try {
    const raw = await webResearch(`What is the contact email address for "${biz.name}", ${biz.address}${biz.phone ? `, phone ${biz.phone}` : ''}? Check their Facebook page, Instagram, Yelp and directory listings. Quote the email exactly as it appears on the page and give that page's URL. If no email is published anywhere, say NONE.`);
    if (/\bNONE\b/.test(raw) && !/@/.test(raw)) return '';
    return pickEmail(raw, biz.website);
  } catch { return ''; }
}

async function findBusiness(s) {
  for (let tries = 0; tries < 4; tries++) {
    const { metro } = pickTarget(s.cursor);
    const segment = SEGMENTS[s.cursor % SEGMENTS.length];
    s.cursor++;
    let list = [];
    try { list = placesKey() ? await placesSearch(`${segment} in ${metro}`) : await webSearchBusinesses(segment, metro); }
    catch (e) { console.error(`site desk failed: finding ${segment} in ${metro} — ${e.message}`); continue; }
    const { leadExists } = require('./scoutLeads');
    for (const b of rankCandidates(list, s.seen).slice(0, 4)) {
      s.seen.push(normName(b.name));
      if (b.website) s.seen.push(hostOf(b.website));
      if (await leadExists(b.name, b.website).catch(() => false)) continue;
      const old = await gatherOld(b.website);
      const email = (old && old.email) || await findEmail(b);
      if (!email) { console.log(`site desk: ${b.name} (${metro}) — no email anywhere, skipped`); continue; }
      return { ...b, segment, metro, email, old };
    }
  }
  return null;
}

// --- building ----------------------------------------------------------------

function factSheet(biz, images) {
  const o = biz.old;
  return [
    `BUSINESS: ${biz.name}`,
    `KIND: ${biz.type || biz.segment}`,
    `ADDRESS: ${biz.address || 'unknown'}`,
    `PHONE: ${biz.phone || 'unknown'}`,
    `EMAIL: ${biz.email}`,
    biz.hours ? `HOURS: ${biz.hours}` : '',
    biz.rating ? `GOOGLE RATING: ${biz.rating} from ${biz.ratings} reviews` : '',
    biz.maps ? `GOOGLE MAPS: ${biz.maps}` : '',
    biz.reviews && biz.reviews.length ? `REAL GOOGLE REVIEWS (quote only these, word for word, first name only):\n${biz.reviews.map((r) => `- ${r.author} (${r.rating}★): "${r.text}"`).join('\n')}` : 'REVIEWS: none given, so no testimonials section.',
    o ? `THEIR CURRENT SITE: ${o.url}${o.builder ? ` (built on ${o.builder})` : ''}${o.copyrightYear ? `, footer says ${o.copyrightYear}` : ''}\nTITLE: ${o.title}\nDESCRIPTION: ${o.description}\nCOLORS IN USE: ${o.colors.join(', ') || 'none found'}\nLOGO: ${o.logo || 'none found'}\nSOCIAL: ${o.socials.join(' ') || 'none'}\nTHEIR OWN WORDS:\n${o.text.slice(0, 7000)}` : 'THEIR CURRENT SITE: none. This will be their first website.',
    `IMAGES YOU MAY USE (real ones, by URL):\n${images.map((i, n) => `${n + 1}. ${i.url}${i.alt ? ` — ${i.alt}` : ''}`).join('\n') || 'none'}`,
  ].filter(Boolean).join('\n');
}

const NO_INVENTING = 'Use only the facts given. Never invent prices, years in business, awards, licenses, guarantees, staff names, services they didn\'t list, or reviews. If something isn\'t given, leave it out.';

const json = (t) => { const m = /\{[\s\S]*\}/.exec(t || ''); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };

async function design(facts) {
  const t = await claudeText(`You are S.E.L.E.N.E., Creative Director of Empire Digital. Dark luxury meets sharp strategy, but for a client you design for THEIR customers and THEIR vibe, not ours. ${NO_INVENTING}`, [{ role: 'user', content:
    `${facts}\n\nGive the design direction for this business's new website: the most modern, premium version of them that still feels like them. If they have a site, keep what's recognizably theirs (logo, colors that work, their voice) and fix what dates it. Return ONLY JSON:\n` +
    '{"vibe":"one line","palette":{"bg":"#","surface":"#","text":"#","accent":"#","accent2":"#"},"fonts":{"heading":"Google Font","body":"Google Font"},"sections":["hero","…in order"],"imagery":"which numbered images go where, and for anything missing a short photo prompt to generate","keep":"what to keep from the old site","fix":"what to fix","details":"motion, texture, layout moves that make it feel current"}' }],
  { maxTokens: 1500, model: MODEL });
  return json(t) || { vibe: String(t || '').slice(0, 800) };
}

async function copy(facts, brief) {
  const t = await claudeText(`You are S.C.R.I.B.E., Empire Digital's writer. You write website copy that sounds like the owner on their best day: clear, warm, specific, no fluff, no clichés like "look no further". ${NO_INVENTING}`, [{ role: 'user', content:
    `${facts}\n\nDESIGN DIRECTION:\n${JSON.stringify(brief)}\n\nWrite the copy for every section. Return ONLY JSON:\n` +
    '{"title":"<title> tag","meta":"meta description","hero":{"headline":"","sub":"","cta":""},"sections":[{"id":"","heading":"","body":"","items":["…"]}],"footer":""}' }],
  { maxTokens: 2500, model: MODEL });
  return json(t) || { raw: String(t || '').slice(0, 4000) };
}

const BUILD_RULES = `Output ONE complete, self-contained HTML file and nothing else: <!doctype html> to </html>.
- All CSS in one <style>; Google Fonts by <link> is fine; no other outside CSS or JS; a little inline JS for a mobile menu or reveal-on-scroll is fine.
- Mobile first, fast, accessible, looks premium on a phone and a laptop. Sticky header with a tap-to-call button.
- Images: only the numbered URLs given, by exact URL, or src="GEN:<short photo description>" for a generated photo where nothing real fits (never for the logo, team or their work). If there's no logo, set the name in the heading font.
- Contact: tel: and mailto: buttons, the address with a Google Maps link, hours if given. No forms.
- Reviews only as given, word for word. ${NO_INVENTING}`;

async function buildHtml(facts, brief, words, images, name, changes = '', current = '') {
  const ask = current
    ? `${facts}\n\nTHE CURRENT PAGE:\n${current}\n\nMAKE THESE CHANGES (everything else stays): ${changes}\n\n${BUILD_RULES}`
    : `${facts}\n\nDESIGN DIRECTION (S.E.L.E.N.E.):\n${JSON.stringify(brief)}\n\nCOPY (S.C.R.I.B.E., use it as written):\n${JSON.stringify(words)}\n\n${BUILD_RULES}${changes ? `\n\nFIX THESE FROM THE LAST TRY: ${changes}` : ''}`;
  const t = await claudeText('You are J.A.R.V.I.S., Empire Digital\'s engineer: a front-end builder with an eye for modern, high-end small-business sites.', [{ role: 'user', content: ask }],
    { maxTokens: 16000, model: MODEL, timeoutMs: 420000 });
  return finishHtml(t, { name, images });
}

async function buildSite(biz, { changes = '', current = '' } = {}) {
  const images = [...((biz.old && biz.old.images) || []), ...(biz.photos || [])].slice(0, 20);
  const facts = factSheet(biz, images);
  const brief = biz.brief || await design(facts);
  const words = biz.words || await copy(facts, brief);
  let html = await buildHtml(facts, brief, words, images, biz.name, changes, current);
  let bad = checkHtml(html, biz);
  if (bad.length && !current) {
    html = await buildHtml(facts, brief, words, images, biz.name, bad.join('; '));
    bad = checkHtml(html, biz);
  }
  if (bad.length) throw new Error(`the page failed its checks: ${bad.join('; ')}`);
  // Generated photos are made on first view; ask for them now so his first look isn't blank.
  for (const m of html.matchAll(/https:\/\/image\.pollinations\.ai\/prompt\/[^"')\s]+/g)) fetch(m[0].replace(/&amp;/g, '&'), { signal: AbortSignal.timeout(90000) }).catch(() => {});
  return { html, brief, words };
}

// --- outreach (S.C.O.U.T.) ---------------------------------------------------

async function emailFor(site, offer) {
  const t = await claudeText('You are S.C.O.U.T., Empire Digital\'s outreach desk: sharp, warm, concrete, never salesy.', [{ role: 'user', content:
    `Write a short cold email to the owner of ${site.name} (${site.kind}, ${site.address}). We ${site.oldUrl ? `took their current website (${site.oldUrl}) and rebuilt it, better and modern` : 'built them their first website'} without being asked. Tell them that in one plain line, give the link, say one specific thing about it that's better for their customers, then the offer, then an easy reply ask. No hype, no "I hope this finds you well", under 120 words. ${NO_INVENTING}\n\n` +
    `LINK: ${siteUrl(site.slug)}\nOFFER (keep its numbers exactly): ${offer}\nSIGN AS: Tarell Burrus, Empire Digital\n\nReply EXACTLY:\nSUBJECT: <short, about their business>\nBODY: <the email>` }],
  { maxTokens: 700 });
  const subject = ((/SUBJECT:\s*(.+)/i.exec(t || '') || [])[1] || '').trim().replace(/^["']|["']$/g, '').slice(0, 140);
  let body = ((/BODY:\s*([\s\S]+)/i.exec(t || '') || [])[1] || '').trim();
  if (!subject || body.length < 40) throw new Error('S.C.O.U.T. did not write a usable email');
  if (!body.includes(siteUrl(site.slug))) body = `${body}\n\n${siteUrl(site.slug)}`;
  body += '\n\nIf you\'d rather not hear from me again, just reply "no thanks" and I won\'t.';
  return { subject, body };
}

async function sendSite(site, s) {
  const { gmailSend } = require('./google');
  const { addLead } = require('./scoutLeads');
  const { subject, body } = await emailFor(site, s.offer || DEFAULT_OFFER);
  await gmailSend({ to: site.email, subject, body });
  const d = new Date(); d.setDate(d.getDate() + 4);
  await addLead({
    name: site.name, business: site.kind, website: site.oldUrl || '', contact: site.email, segment: `${site.segment} · ${site.metro}`,
    bottleneck: site.oldUrl ? 'dated website' : 'no website', stage: 'contacted', source: 'site-desk', value: 1000,
    next_touch: d.toISOString().slice(0, 10), next_action: 'await reply on the demo site / follow up',
    log: `${todayET()} — Emailed demo site: ${subject} — ${siteUrl(site.slug)}${site.phone ? ` (phone ${site.phone})` : ''}`,
  }).catch((e) => console.error('site desk failed: lead not saved —', e.message));
  await putSite(site.slug, { ...stripSite(site), status: 'sent', sentAt: Date.now(), subject }, null);
  return subject;
}

const stripSite = ({ slug, created_at, ...rest }) => rest;
const tell = (text, spoken) => require('./talonAlerts').sendFromAra(text, spoken || text, { remember: true })
  .catch((e) => console.error('site desk failed: telling him —', e.message));

// --- the cycle ---------------------------------------------------------------

let busy = false;

async function buildOne(s, { force = false } = {}) {
  const biz = await findBusiness(s);
  await save(s);
  if (!biz) return { skipped: 'no business with an email found this round' };
  if (biz.photoNames && biz.photoNames.length && placesKey()) biz.photos = await placePhotos(biz.photoNames);
  const { html, brief, words } = await buildSite(biz);
  const slug = slugFor(biz.name);
  const review = s.reviewLeft > 0;
  const site = {
    name: biz.name, kind: biz.type || biz.segment, segment: biz.segment, metro: biz.metro, address: biz.address, phone: biz.phone,
    email: biz.email, oldUrl: (biz.old && biz.old.url) || '', maps: biz.maps || '', rating: biz.rating, ratings: biz.ratings,
    status: review ? 'review' : 'approved', brief, words, facts: { ...biz, old: biz.old ? { ...biz.old, text: biz.old.text.slice(0, 8000) } : null },
    source: placesKey() ? 'google maps' : 'web search',
  };
  await putSite(slug, site, html);
  s.builtToday++;
  await save(s);
  const url = siteUrl(slug);
  const what = site.oldUrl ? `a redesign of their site (${site.oldUrl})` : 'their first website';
  if (review) {
    await tell(`🌐 **J.A.R.V.I.S. built a website for ${site.name}**, Mr. Burrus: ${what}.\n${site.kind} · ${site.address}${site.rating ? ` · ${site.rating}★ (${site.ratings})` : ''}\nReview it: ${url}\nS.C.O.U.T. will email it to ${site.email} once you approve. Tell J.A.R.V.I.S. "approve ${site.name}", what to change, or "drop it". (${REVIEW_FIRST - s.reviewLeft + 1} of the first ${REVIEW_FIRST} you review; after that they go out on their own.)`,
    `J.A.R.V.I.S. built a website for ${site.name}, ${what}. The link's in the chat. Nothing goes to them until you approve it.`);
    return { built: site.name, url, review: true };
  }
  const subject = await sendSite({ ...site, slug }, s);
  await tell(`🌐 **New site sent: ${site.name}**, Mr. Burrus. ${what}.\n${url}\nS.C.O.U.T. emailed it to ${site.email}: "${subject}"`,
    `J.A.R.V.I.S. built ${site.name} a website and Scout emailed it to them. The link's in the chat.`);
  return { built: site.name, url, sent: true, force };
}

// Approved sites not sent yet (his OK came in, or a send failed last time).
async function sendApproved(s) {
  for (const site of (await allSites()).filter((x) => x.status === 'approved').slice(0, 2)) {
    try {
      const subject = await sendSite(site, s);
      await tell(`📨 S.C.O.U.T. emailed **${site.name}** their new site (${site.email}): "${subject}"\n${siteUrl(site.slug)}`, `Scout emailed ${site.name} their new site.`);
    } catch (e) { console.error(`site desk failed: emailing ${site.name} — ${e.message}`); }
  }
}

async function tick({ force = false } = {}) {
  if (!enabled() || busy) return { skipped: busy ? 'already building one' : 'SITE_DESK is off' };
  busy = true;
  try {
    const s = await load();
    if (s.day !== todayET()) { s.day = todayET(); s.builtToday = 0; await save(s); }
    const h = hourET();
    if (!force && (h < 9 || h >= 18)) return { skipped: 'outside 9 AM-6 PM ET' };
    await sendApproved(s);
    const perDay = Math.max(0, parseInt(await getSetting('site_desk_per_day', '3'), 10) || 0);
    if (!force && s.builtToday >= perDay) return { skipped: `${s.builtToday} built today, the most for a day` };
    const waiting = (await allSites()).filter((x) => x.status === 'review').length;
    if (waiting >= MAX_WAITING) return { skipped: `${waiting} sites are waiting on his review` };
    return await buildOne(s, { force });
  } catch (e) {
    console.error('site desk failed:', e.message);
    return { error: e.message };
  } finally {
    busy = false;
  }
}

// --- his tags ----------------------------------------------------------------

async function siteByName(ref) {
  const n = normName(ref);
  const live = (await allSites()).filter((x) => x.status !== 'dropped');
  if (!n) return live.find((x) => x.status === 'review') || null;
  return live.find((x) => normName(x.name) === n || x.slug === String(ref).trim()) || live.find((x) => normName(x.name).includes(n) || n.includes(normName(x.name))) || null;
}

async function statusText() {
  const s = await load();
  const sites = await allSites();
  const line = (x) => `- ${x.name} (${x.kind}, ${x.metro}) — ${x.status}${x.status === 'sent' ? ` to ${x.email}` : ''} · ${siteUrl(x.slug)}`;
  return [
    `Finding businesses through: ${placesKey() ? 'Google Maps (Places API)' : 'web search — no GOOGLE_PLACES_API_KEY on the server, so not Google Maps itself yet'}.`,
    `Built today: ${s.builtToday} of ${await getSetting('site_desk_per_day', '3')}. Reviews left before sites go out on their own: ${s.reviewLeft}.`,
    `Offer in the emails: ${s.offer || DEFAULT_OFFER}`,
    sites.length ? `Sites:\n${sites.filter((x) => x.status !== 'dropped').slice(0, 15).map(line).join('\n')}` : 'No sites built yet.',
  ].join('\n');
}

async function tag(name, arg, asked = '') {
  if (name === 'SITE_DESK') {
    if (/run|build|now|go/i.test(arg || '')) {
      if (busy) return 'already building one; A.R.A. sends him the link when it\'s done.';
      tick({ force: true }).then((r) => { if (r && (r.error || r.skipped)) tell(`🌐 Website desk: ${r.error ? `the build failed — ${r.error}` : r.skipped}`); });
      return 'started building one now (a few minutes). A.R.A. sends him the link when it\'s ready; don\'t claim it\'s built.';
    }
    return statusText();
  }
  if (!String(asked || '').trim()) return 'not done: that needs Mr. Burrus\'s own message.';
  const [ref, ...rest] = String(arg || '').split('|');
  if (name === 'SITE_OFFER') {
    const s = await load();
    s.offer = String(arg || '').trim();
    await save(s);
    return s.offer ? `the email offer is now: ${s.offer}` : `back to the default offer: ${DEFAULT_OFFER}`;
  }
  const site = await siteByName(ref);
  if (!site) return `no site found for "${ref.trim()}". ${await statusText()}`;
  if (name === 'SITE_DROP') {
    await putSite(site.slug, { ...stripSite(site), status: 'dropped' }, null);
    return `dropped ${site.name}; nothing will be sent and the page is off.`;
  }
  if (name === 'SITE_APPROVE') {
    if (site.status === 'sent') return `${site.name} was already emailed.`;
    const s = await load();
    if (site.status === 'review') s.reviewLeft = Math.max(0, s.reviewLeft - 1);
    await save(s);
    await putSite(site.slug, { ...stripSite(site), status: 'approved' }, null);
    try {
      const subject = await sendSite(site, s);
      return `approved. S.C.O.U.T. emailed ${site.name} at ${site.email}: "${subject}". Reviews left before they go out on their own: ${s.reviewLeft}.`;
    } catch (e) {
      console.error(`site desk failed: emailing ${site.name} — ${e.message}`);
      return `approved, but the email didn't go out (${e.message}); it'll be tried again on the next run.`;
    }
  }
  if (name === 'SITE_REVISE') {
    const changes = rest.join('|').trim();
    if (!changes) return 'say what to change.';
    const current = String(await getHtml(site.slug) || '').replace(/<div id="empire-preview"[\s\S]*?<\/div>/, '').replace('<meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1">', '');
    (async () => {
      try {
        const { html } = await buildSite({ ...site.facts, brief: site.brief, words: site.words }, { changes, current });
        await putSite(site.slug, { ...stripSite(site), status: site.status === 'sent' ? 'sent' : 'review', revisions: [...(site.revisions || []), changes] }, html);
        await tell(`🌐 **${site.name}** is updated, Mr. Burrus: ${changes}\n${siteUrl(site.slug)}\nSay approve when it's right.`, `${site.name}'s site is updated. Same link.`);
      } catch (e) {
        console.error(`site desk failed: revising ${site.name} — ${e.message}`);
        tell(`⚠️ The change to ${site.name}'s site didn't work: ${e.message}`);
      }
    })();
    return `making the change to ${site.name} now (a few minutes); A.R.A. sends him the same link when it's done. Don't claim it's done.`;
  }
  return '';
}

const SITE_TAGS = new Set(['SITE_DESK', 'SITE_APPROVE', 'SITE_REVISE', 'SITE_DROP', 'SITE_OFFER']);
const SITE_TOOLS = ` THE WEBSITE DESK — S.C.O.U.T. finds local businesses (Google Maps), J.A.R.V.I.S. builds each a new website (their old one made better and modern, or their first), S.E.L.E.N.E. directs the design and S.C.R.I.B.E. writes the copy, and S.C.O.U.T. emails the owner the link with the offer. Up to 3 a day, 9 AM-6 PM ET, on its own. The first ${REVIEW_FIRST} wait for his approval; after that they go out as they're built and he gets the link.
 - [SITE_DESK] — what's been built, sent and waiting, with links. [SITE_DESK: run] builds one now.
 - [SITE_APPROVE: business name] — on his OK: S.C.O.U.T. emails it to them right away.
 - [SITE_REVISE: business name | exactly what to change] — rebuild it with his changes; same link.
 - [SITE_DROP: business name] — never send it; the page comes down.
 - [SITE_OFFER: the price line for the emails] — what the emails offer (default: ${DEFAULT_OFFER})`;

module.exports = { tick, tag, SITE_TAGS, SITE_TOOLS, getHtml, statusText, readOldSite, pickEmail, finishHtml, checkHtml, rankCandidates, slugFor, DEFAULT_OFFER };
