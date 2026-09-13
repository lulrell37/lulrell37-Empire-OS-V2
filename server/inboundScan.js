// Inbound signal sweep for S.C.O.U.T.'s outreach cron — server-side port of
// runInboundScan() from src/services/inbound.js (the Google-Form importer,
// importInboundForm(), isn't ported — it's a niche optional channel, not
// required for outreach to fire). Every channel here is a plain public fetch;
// the only AI-backed one (X/Twitter) uses server/llm.js's webResearch instead
// of the client's provider-routed webSearch.
const { webResearch } = require('./llm');
const { craigslistSub } = require('./scoutTargets');

const DEFAULT_QUERIES = [
  'looking for someone to automate',
  'is there a tool that can',
  'need help automating my business',
  'want a custom app for my business',
  'drowning in admin work',
];
const REDDIT_SUBS = 'smallbusiness+Entrepreneur+sweatystartup+msp+Automate+nocode+ecommerce+shopify+PropertyManagement+nonprofit+HVAC+electricians+Plumbing+landscaping+Contractor';
const LOCAL_SUBS = 'nyc+LosAngeles+chicago+houston+Atlanta+washingtondc+Seattle+austin+Denver+boston+phoenix+Dallas+Portland+Nashville+SanDiego';
const LOCAL_QUERIES = [
  '"recommend a web developer" OR "someone to build a website" OR "app developer"',
  '"looking for someone to automate" OR "build a custom" OR "software developer"',
];

function ageStr(ms) {
  if (!ms) return '';
  const h = Math.floor((Date.now() - ms) / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}
function dedupeByUrl(arr) {
  const seen = new Set();
  return arr.filter((x) => {
    if (!x.url) return true;
    if (seen.has(x.url)) return false;
    seen.add(x.url); return true;
  });
}

async function scanReddit(queries, subs = REDDIT_SUBS) {
  const out = [];
  for (const q of queries) {
    try {
      const url = `https://www.reddit.com/r/${subs}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&limit=8&t=month`;
      const res = await fetch(url, { headers: { 'User-Agent': 'EmpireOS/1.0 (lead scout)' } });
      if (!res.ok) continue;
      const j = await res.json();
      for (const c of (j?.data?.children || [])) {
        const d = c.data || {};
        out.push({ source: 'reddit', title: d.title || '', text: String(d.selftext || '').replace(/\s+/g, ' ').slice(0, 240), tag: 'r/' + (d.subreddit || ''), age: ageStr((d.created_utc || 0) * 1000), url: 'https://reddit.com' + (d.permalink || '') });
      }
    } catch {}
  }
  return dedupeByUrl(out);
}

const BSKY_QUERIES = [
  'looking for someone to build a custom tool for my business',
  'anyone know a developer who can automate this',
  'is there a tool that does this for a small business',
];
function bskyUrl(uri, handle) {
  const rkey = String(uri || '').split('/').pop();
  return handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : '';
}
async function scanBluesky(queries) {
  const qs = (queries && queries.length) ? queries : BSKY_QUERIES;
  const out = [];
  for (const q of qs.slice(0, 3)) {
    try {
      const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=15&sort=latest`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = await res.json();
      for (const p of (j?.posts || [])) {
        const txt = String(p?.record?.text || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        out.push({ source: 'bluesky', title: txt.slice(0, 150), text: txt.length > 150 ? txt.slice(150, 340) : '', tag: '@' + (p?.author?.handle || 'bsky'), age: ageStr(Date.parse(p?.indexedAt || p?.record?.createdAt || '')), url: bskyUrl(p?.uri, p?.author?.handle) });
      }
    } catch {}
  }
  return dedupeByUrl(out).slice(0, 14);
}

const NOCODE_FORUMS = ['forum.bubble.io', 'community.retool.com', 'community.n8n.io', 'community.make.com', 'community.zapier.com'];
const NOCODE_KEEP = /hire|freelanc|consult|contractor|need someone|someone to build|pay someone|\bbudget\b/i;
async function scanNoCodeForums() {
  const per = await Promise.all(NOCODE_FORUMS.map(async (host) => {
    try {
      const url = `https://${host}/search.json?q=${encodeURIComponent('hire order:latest')}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'EmpireOS/1.0 (lead scout)' } });
      if (!res.ok) return [];
      const j = await res.json();
      const topic = {};
      for (const t of (j?.topics || [])) topic[t.id] = { title: t.title || '', slug: t.slug, id: t.id, created: t.created_at };
      const rows = [];
      for (const post of (j?.posts || []).slice(0, 8)) {
        const t = topic[post.topic_id];
        if (!t) continue;
        const blurb = String(post.blurb || '').replace(/\s+/g, ' ').trim();
        if (!NOCODE_KEEP.test(t.title + ' ' + blurb)) continue;
        rows.push({ source: 'forum', title: t.title, text: blurb.slice(0, 240), tag: host.replace(/^(community|forum)\./, '').replace(/\..*$/, ''), age: ageStr(Date.parse(t.created || post.created_at || '')), url: `https://${host}/t/${t.slug}/${t.id}` });
      }
      return rows;
    } catch { return []; }
  }));
  return dedupeByUrl(per.flat()).slice(0, 10);
}

const SRECS_KEEP = /\b(business|compan|invoic|billing|\bcrm\b|schedul|booking|appointment|inventory|payroll|\bclient|customer|\blead\b|pipeline|automat|workflow|spreadsheet|\bexcel\b|\bquote|estimat|dispatch|field.?service|e-?commerce|shopify|point of sale|\bpos\b)/i;
async function scanSoftwareRecs() {
  const out = [];
  try {
    const url = 'https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&site=softwarerecs&pagesize=40';
    const res = await fetch(url);
    if (!res.ok) return [];
    const j = await res.json();
    for (const it of (j?.items || [])) {
      const title = it.title || '';
      const tags = (it.tags || []).join(' ');
      if (!SRECS_KEEP.test(title + ' ' + tags)) continue;
      out.push({ source: 'softwarerecs', title: clDecode(title), text: it.is_answered ? '(already has an answer)' : '', tag: 'softwarerecs', age: ageStr((it.creation_date || 0) * 1000), url: it.link || '' });
    }
  } catch {}
  return out.slice(0, 10);
}

async function scanHnFreelance() {
  const out = [];
  const since = Math.floor((Date.now() - 45 * 86400000) / 1000);
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=%22SEEKING%20FREELANCER%22&tags=comment&numericFilters=created_at_i%3E${since}&hitsPerPage=20`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const j = await res.json();
    for (const h of (j?.hits || [])) {
      const body = String(h.comment_text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!/seeking\s+freelancer/i.test(body)) continue;
      out.push({ source: 'hn-freelance', title: body.slice(0, 160), text: body.length > 160 ? body.slice(160, 420) : '', tag: 'HN freelance', age: ageStr((h.created_at_i || 0) * 1000), url: `https://news.ycombinator.com/item?id=${h.objectID}` });
    }
  } catch {}
  return out.slice(0, 10);
}

const GIG_SUBS = 'forhire+jobbit+slavelabour';
const GIG_BUYING = /\[\s*(hiring|task)\s*\]/i;
const GIG_NOT = /\[\s*(for ?hire|offer|closed)\s*\]/i;
const DEVISH = /\b(develop(er|ment)?|program(mer|ming)?|python|javascript|typescript|node|react|automat(e|ion|ing)|script|web ?site|web ?app|land(ing)? ?page|scrap(e|er|ing)|crawl(er|ing)|\bapi\b|integrat(e|ion)|software|\bapp\b|\bbot\b|chat ?bot|spreadsheet|excel|google she?ets?|airtable|zapier|make\.com|dashboard|database|\bsql\b|no-?code|low-?code|saas|chrome extension|plugin|wordpress|shopify|webflow|data entry automation|workflow)\b/i;
async function scanGigBoards() {
  const out = [];
  try {
    const url = `https://www.reddit.com/r/${GIG_SUBS}/new.json?limit=40&raw_json=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'EmpireOS/1.0 (lead scout)' } });
    if (!res.ok) return [];
    const j = await res.json();
    for (const c of (j?.data?.children || [])) {
      const d = c.data || {};
      const title = d.title || '';
      if (!GIG_BUYING.test(title) || GIG_NOT.test(title)) continue;
      const body = String(d.selftext || '').replace(/\s+/g, ' ').trim();
      if (!DEVISH.test(title + ' ' + body)) continue;
      out.push({ source: 'gig', title, text: body.slice(0, 300), tag: 'r/' + (d.subreddit || ''), age: ageStr((d.created_utc || 0) * 1000), url: 'https://reddit.com' + (d.permalink || '') });
    }
  } catch {}
  return dedupeByUrl(out).slice(0, 12);
}

function clDecode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const CL_BOARDS = [['cpg', 'computer gig'], ['web', 'web/design gig'], ['sof', 'software job']];
async function scanCraigslist(metro) {
  const sub = craigslistSub(metro);
  if (!sub) return [];
  const out = [];
  for (const [slug, kind] of CL_BOARDS) {
    try {
      const url = `https://${sub}.craigslist.org/search/${slug}?format=rss`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmpireOS lead scout)' } });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
        const block = m[1];
        const title = clDecode((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
        const link = clDecode((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]) || (block.match(/rdf:about="([^"]+)"/) || [])[1] || '';
        const desc = clDecode((block.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
        const date = (block.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1] || '';
        if (!title) continue;
        out.push({ source: 'craigslist', title, text: desc.slice(0, 260), tag: `craigslist ${sub} · ${kind}`, age: date ? ageStr(Date.parse(date)) : '', url: link });
      }
    } catch {}
  }
  return dedupeByUrl(out).slice(0, 16);
}

async function scanHackerNews(queries) {
  const out = [];
  const since = Math.floor((Date.now() - 30 * 86400000) / 1000);
  for (const q of queries) {
    try {
      const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=(story,comment,ask_hn)&numericFilters=created_at_i>${since}&hitsPerPage=6`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = await res.json();
      for (const h of (j?.hits || [])) {
        const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const title = h.title || h.story_title || strip(h.comment_text).slice(0, 120);
        if (!title) continue;
        out.push({ source: 'hn', title, text: strip(h.story_text || h.comment_text).slice(0, 240), tag: 'HN', age: ageStr((h.created_at_i || 0) * 1000), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}` });
      }
    } catch {}
  }
  return dedupeByUrl(out);
}

const X_QUERIES = [
  'small business owners on X this week saying "looking for someone to build" a custom tool or automation',
  'X posts this week asking "does anyone know a developer who can automate" for a small business',
];
async function scanX(customQuery) {
  const queries = customQuery ? [`${customQuery} — recent posts on X / Twitter, people asking for this`] : X_QUERIES;
  const blocks = [];
  for (const q of queries) {
    try {
      const r = await webResearch(q);
      if (r && String(r).trim()) blocks.push(String(r).trim().slice(0, 1200));
    } catch {}
  }
  return blocks;
}

// Returns a text digest S.C.O.U.T. triages into [LEAD_ADD]-style rows. Passing
// a metro sweeps that city's Craigslist gig/job boards too.
async function runInboundScan(extraQuery, opts = {}) {
  const custom = String(extraQuery || '').trim();
  const queries = custom ? [custom] : DEFAULT_QUERIES;
  const metro = String(opts?.metro || '').trim();
  const parts = [];

  const [hn, xBlocks, reddit, redditLocal, gigs, craigslist, bluesky, forums, srecs, hnFree] = await Promise.all([
    scanHackerNews(queries.slice(0, 4)).catch(() => []),
    scanX(custom).catch(() => []),
    scanReddit(queries.slice(0, 4)).catch(() => []),
    scanReddit(custom ? [custom] : LOCAL_QUERIES, LOCAL_SUBS).catch(() => []),
    scanGigBoards().catch(() => []),
    metro ? scanCraigslist(metro).catch(() => []) : Promise.resolve([]),
    scanBluesky(custom ? [custom] : null).catch(() => []),
    scanNoCodeForums().catch(() => []),
    scanSoftwareRecs().catch(() => []),
    scanHnFreelance().catch(() => []),
  ]);

  const fmt = (list, n = 6) => list.slice(0, n).map((p) => `  [${p.tag}${p.age ? ` · ${p.age}` : ''}] ${p.title}${p.text ? `\n    ${p.text}` : ''}\n    ${p.url}`).join('\n');

  parts.push(hn.length ? 'HACKER NEWS — recent posts matching the search:\n' + fmt(hn, 8) : 'HACKER NEWS — nothing matched in the last month.');
  parts.push(xBlocks.length ? 'X / TWITTER — people posting about this right now:\n' + xBlocks.join('\n\n') : 'X / TWITTER — nothing matched.');
  parts.push(bluesky.length ? 'BLUESKY — people posting this right now:\n' + fmt(bluesky, 8) : 'BLUESKY — nothing matched.');
  parts.push(gigs.length ? 'GIG BOARDS (Reddit r/forhire · r/jobbit · r/slavelabour) — open [Hiring]/[Task] posts for our kind of work:\n' + fmt(gigs, 8) : 'GIG BOARDS — no open software/automation gigs right now.');
  if (metro) parts.push(craigslist.length ? `CRAIGSLIST ${metro} — local computer / web gigs and software jobs:\n` + fmt(craigslist, 10) : `CRAIGSLIST ${metro} — nothing on the local boards (or they were unreachable).`);
  if (srecs.length) parts.push('SOFTWARE RECOMMENDATIONS (StackExchange) — "is there a tool that…" from owners:\n' + fmt(srecs, 8));
  if (hnFree.length) parts.push('HN · SEEKING FREELANCER — outfits hiring a build out this cycle:\n' + fmt(hnFree, 8));
  if (forums.length) parts.push('NO-CODE / AUTOMATION FORUMS (Bubble · Retool · n8n · Make · Zapier) — people stuck who may want to hire it out:\n' + fmt(forums, 8));
  const redditAll = [...reddit, ...redditLocal];
  if (redditAll.length) parts.push('REDDIT (business + city subs) — recent posts matching the search:\n' + fmt(redditAll, 12));

  return parts.filter(Boolean).join('\n\n---\n\n');
}

module.exports = { runInboundScan };
