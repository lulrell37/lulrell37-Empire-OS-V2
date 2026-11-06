// S.E.L.E.N.E.'s Instagram watch. Mondays and Thursdays at 7 AM ET she tells Mr.
// Burrus what's trending and how his presence measures up, on her own Telegram bot
// (A.R.A.'s if hers isn't set up). SELENE_TRENDS=off stops it.
//
// Instagram has no public trends feed and logged-out pages redirect to login, so
// the two sources are kept apart and labeled:
//   - His accounts and any watched ones: real numbers from the Meta Graph API,
//     using the ig_user_id + access_token saved per page in the Content screen
//     (app_settings.content_pages). business_discovery can only read public
//     Business/Creator accounts.
//   - Trends: live web research, which is reported trends, not Instagram's own data.
// Nothing here posts anything.
const { chatAs, webResearch } = require('./llm');
const { getSetting, setSetting, saveMemory, todayET } = require('./syncStore');
const { ROSTER } = require('./personas');
const { query } = require('./db');

const GRAPH = 'https://graph.facebook.com/v21.0';
const MEDIA_FIELDS = 'caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink';
const DEFAULT_NICHE = 'personal development and mindset, discipline, entrepreneurship and building a business, faith, talking-head short video';
const DAY = 86400e3;

async function graph(path, params) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const d = await res.json().catch(() => ({}));
  // Meta's error message, never the URL: it carries the token.
  if (!res.ok || d.error) throw new Error(`Instagram API: ${d.error?.message || res.status}`);
  return d;
}

// Posting pace and engagement over recent posts. Pure.
function mediaStats(media, now = Date.now()) {
  const list = (media || []).filter((p) => p && p.timestamp);
  if (!list.length) return null;
  const eng = (p) => (Number(p.like_count) || 0) + (Number(p.comments_count) || 0);
  const age = (p) => now - Date.parse(p.timestamp);
  const recent = list.filter((p) => age(p) <= 14 * DAY);
  const kinds = {};
  for (const p of list) {
    const k = p.media_product_type === 'REELS' ? 'reels' : String(p.media_type || 'post').toLowerCase();
    (kinds[k] = kinds[k] || []).push(eng(p));
  }
  const top = [...list].sort((a, b) => eng(b) - eng(a))[0];
  return {
    postsPerWeek: +(recent.length / 2).toFixed(1),
    daysSinceLast: Math.floor(Math.min(...list.map(age)) / DAY),
    avgEngagement: Math.round(list.reduce((a, p) => a + eng(p), 0) / list.length),
    byKind: Object.entries(kinds).map(([k, v]) => `${k} ${Math.round(v.reduce((a, x) => a + x, 0) / v.length)} avg over ${v.length}`).join(', '),
    top: { engagement: eng(top), caption: String(top.caption || '').slice(0, 120), link: top.permalink },
  };
}

function statsLine(label, followers, s) {
  if (!s) return `${label}: no posts to read.`;
  return `${label}: ${followers != null ? `${followers} followers, ` : ''}${s.postsPerWeek} posts/week over the last 14 days, last post ${s.daysSinceLast}d ago, ${s.avgEngagement} avg likes + comments (${s.byKind}). Best recent: ${s.top.engagement} on "${s.top.caption}" ${s.top.link || ''}`;
}

async function loadPages() {
  const raw = await getSetting('content_pages', '{}').catch(() => '{}');
  let pages = {};
  try { pages = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { /* */ }
  return Object.entries(pages).map(([id, p]) => ({ id, ...p })).filter((p) => p.ig_user_id && p.access_token && p.active !== false);
}

async function watchList() {
  const raw = await getSetting('selene_watch', '[]').catch(() => '[]');
  try { const a = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

const cleanHandle = (h) => {
  const x = String(h || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(x) ? x : '';
};

// Real numbers: his pages, then the accounts he's measuring himself against.
async function accountData() {
  const pages = await loadPages();
  const lines = [], problems = [];
  for (const p of pages) {
    try {
      const [me, media] = await Promise.all([
        graph(p.ig_user_id, { fields: 'username,followers_count', access_token: p.access_token }),
        graph(`${p.ig_user_id}/media`, { fields: MEDIA_FIELDS, limit: '25', access_token: p.access_token }),
      ]);
      lines.push(statsLine(`YOUR @${me.username || p.handle || p.name || p.id}`, me.followers_count, mediaStats(media.data)));
    } catch (e) { problems.push(`${p.handle || p.name || p.id}: ${e.message}`); }
  }
  const handles = await watchList();
  if (pages[0]) {
    for (const h of handles) {
      try {
        const d = await graph(pages[0].ig_user_id, { fields: `business_discovery.username(${h}){username,followers_count,media.limit(25){${MEDIA_FIELDS}}}`, access_token: pages[0].access_token });
        const b = d.business_discovery || {};
        lines.push(statsLine(`WATCHED @${b.username || h}`, b.followers_count, mediaStats(b.media?.data)));
      } catch (e) { problems.push(`@${h}: ${e.message}`); }
    }
  }
  return { lines, problems, connected: pages.length, watched: handles.length };
}

async function buildBrief() {
  const niche = String(await getSetting('social_niche', '').catch(() => '') || DEFAULT_NICHE);
  const [trends, accounts] = await Promise.all([
    webResearch(`Instagram trends this week, as of ${todayET()}, for creators in: ${niche}. Search for the current trending Reels formats and hooks, trending audio with its name, topics getting traction, recent algorithm or feature changes from Instagram or Adam Mosseri, and creators in this niche breaking out. Be specific, give the source and date for each, and leave out anything older than about a month.`),
    accountData().catch((e) => ({ lines: [], problems: [e.message], connected: 0, watched: 0 })),
  ]);
  if (!String(trends || '').trim()) return { skipped: 'no trend research came back' };
  const noData = !accounts.lines.length;
  const p = ROSTER.selene;
  const sys = `You are S.E.L.E.N.E., Creative Director of The Empire. Dark luxury meets sharp strategy; decisive, a little cold. You're giving Mr. Burrus his Instagram watch. His niche: ${niche}.
Write, under 260 words, plain text, **bold** for section names only:
**Trending now**: the top 3-5, each with what it is, why it fits him or doesn't, and how he'd use it. Name real sounds, formats or topics from the research.
**Your presence**: ${noData ? 'you have no account numbers this time. Say so in one line, and do not estimate his numbers or say how he compares.' : 'his real numbers against the watched accounts and against a pace worth holding: is he on par, ahead or behind, and where. Only use the numbers given.'}
**This week's moves**: exactly 3 concrete things to do.
The trends come from web reports, not from Instagram itself: never present them as Instagram's own data, and leave out anything the research doesn't support.`;
  const user = `TREND RESEARCH (web reports):\n${String(trends).slice(0, 6000)}\n\nACCOUNT NUMBERS (Instagram API):\n${accounts.lines.join('\n') || '(none)'}`;
  const body = String(await chatAs(p.api, p.model, sys, [{ role: 'user', content: user }], { maxTokens: 800 }) || '').trim();
  if (!body) return { skipped: 'no brief came back' };
  const foot = [];
  if (!accounts.connected) foot.push('Your Instagram numbers aren\'t connected: add the Instagram User ID and access token in the Content screen and I can measure you for real.');
  else if (!accounts.watched) foot.push('Tell me which accounts to measure you against and I\'ll track them.');
  if (accounts.problems.length) foot.push(`Couldn't read: ${accounts.problems.join('; ').slice(0, 400)}`);
  return { body, foot: foot.join('\n') };
}

// Her bot if she has one, else A.R.A.'s. Voice note, then the text, and logged
// to that bot's history so he can reply about it.
async function deliver(text, spoken) {
  const telegram = require('./telegram');
  const own = telegram.botFor('selene');
  if (!own || !own.isConfigured()) return require('./talonAlerts').sendFromAra(`🖤 **S.E.L.E.N.E. → A.R.A.**\n${text}`, spoken);
  const { ogg } = await require('./personaVoice').voiceNote('selene', String(spoken).replace(/\*\*/g, '')).catch(() => ({ ogg: null }));
  if (ogg) await own.sendVoice(telegram.OWNER_ID, ogg).catch((e) => console.error('selene voice failed:', e.message));
  await own.sendMessage(telegram.OWNER_ID, text);
  await query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', ['selene', 'assistant', text, Date.now()]).catch(() => {});
  return true;
}

async function runInstagramWatch() {
  const b = await buildBrief();
  if (!b.body) return b;
  const text = `📸 **S.E.L.E.N.E. — Instagram watch**, Mr. Burrus.\n\n${b.body}${b.foot ? `\n\n${b.foot}` : ''}`;
  const sent = await deliver(text, b.body);
  // S.C.R.I.B.E. writes Monday's scripts off this.
  await setSetting('selene_trend_brief', JSON.stringify({ at: Date.now(), body: b.body })).catch(() => {});
  await saveMemory('selene', `[your Instagram watch] ${b.body}`.slice(0, 1500)).catch(() => {});
  await saveMemory('ara', `[S.E.L.E.N.E.'s Instagram watch, her read, sent to Mr. Burrus] ${b.body}`.slice(0, 1500)).catch(() => {});
  return { sent, text };
}

async function watchAccount(arg, remove = false) {
  const h = cleanHandle(arg);
  if (!h) return `"${arg}" isn't an Instagram handle.`;
  const list = await watchList();
  const next = remove ? list.filter((x) => x !== h) : [...new Set([...list, h])].slice(0, 15);
  await setSetting('selene_watch', JSON.stringify(next));
  return `Watching: ${next.map((x) => `@${x}`).join(', ') || 'nobody'}. Only public Business or Creator accounts can be read.`;
}

async function setNiche(arg) {
  const n = String(arg || '').trim().slice(0, 300);
  if (!n) return 'No niche given.';
  await setSetting('social_niche', n);
  return `Niche set: ${n}`;
}

module.exports = { runInstagramWatch, watchAccount, setNiche, mediaStats, cleanHandle };
