// A.R.A.'s 6 AM morning brief, pushed to the owner on Telegram (A.R.A.'s bot).
//
// In order: the date, today's weather hour by hour, today's calendar, unread
// email, news (AP World + U.S., Ground News World + U.S., FOX 5 DC), what's
// trending on X (Twitter) in the U.S., today's gold-moving events (Gold Watch),
// then the HUD's Word / Verse / Fact of the Day.
//
// Data sections are assembled straight from their sources (Open-Meteo, Google,
// the FOX 5 DC RSS feed, hud_state) so nothing in them is paraphrased or
// invented; only the AP / Ground News headline pulls go through a web-search
// model call, since neither site publishes a usable feed. Each section fails on
// its own — a dead source prints a one-line "unavailable" and the brief still
// goes out.
//
// Once per day (app_settings `morning_brief_date`), so a restart can't double
// it. MORNING_BRIEF=off disables this instance's cron.
//
// Also: the Word of the Day reminder (word, definition, used in a sentence)
// A.R.A. re-sends every few hours through the day — WORD_REMINDER=off to stop.
const { query } = require('./db');

const TZ = 'America/New_York';
const DEFAULT_PLACE = 'Waldorf, MD';

const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const hourET = () => +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date());

async function syncedRow(table, syncId) {
  const { rows } = await query(
    'SELECT data FROM sync_rows WHERE table_name = $1 AND sync_id = $2 AND deleted = false',
    [table, syncId],
  );
  return rows[0] ? rows[0].data || {} : null;
}
async function getSetting(key) {
  const d = await syncedRow('app_settings', key);
  return d ? d.value : undefined;
}
async function setSetting(key, value) {
  await query(
    `INSERT INTO sync_rows (table_name, sync_id, data, updated_at, deleted, server_seq)
       VALUES ('app_settings', $1, $2, $3, false, nextval('sync_seq'))
     ON CONFLICT (table_name, sync_id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at,
           deleted = false, server_seq = nextval('sync_seq')`,
    [key, JSON.stringify({ key, value: String(value) }), Date.now()],
  );
}

// Three tries with a short backoff — Open-Meteo occasionally times out or 5xxs
// for a moment, which used to print the whole weather section as unavailable.
async function fetchText(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (EmpireOS morning brief)' }, signal: AbortSignal.timeout(15000) });
      if (res.ok) return res.text();
      last = new Error(`${res.status} from ${new URL(url).host}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = new Error(`${new URL(url).host}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw last;
}

// --- Weather (Open-Meteo, no key) ---
const WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Severe thunderstorm', '⛈️'],
};
const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Open-Meteo's geocoder only matches a bare place name ("Waldorf, MD" finds
// nothing), so search the name and pick the result in the given state.
// The last good lookup is kept (per place) so a geocoder outage doesn't take
// the forecast down with it.
const geoCache = {};
async function geocode(place) {
  const [name, region = ''] = place.split(',').map((s) => s.trim());
  let d;
  try {
    d = JSON.parse(await fetchText(`https://geocoding-api.open-meteo.com/v1/search?count=10&name=${encodeURIComponent(name)}`));
  } catch (e) {
    if (geoCache[place]) return geoCache[place];
    const saved = await getSetting(`weather_geo:${place}`).catch(() => null);
    if (saved) { try { return (geoCache[place] = JSON.parse(saved)); } catch {} }
    throw e;
  }
  const results = d.results || [];
  if (!results.length) throw new Error(`place not found: ${place}`);
  const want = (STATES[region.toUpperCase()] || region).toLowerCase();
  const g = (want && results.find((r) => String(r.admin1 || '').toLowerCase() === want || String(r.country || '').toLowerCase() === want)) || results[0];
  const out = { label: [g.name, g.admin1].filter(Boolean).join(', '), lat: g.latitude, lon: g.longitude };
  if (!geoCache[place]) setSetting(`weather_geo:${place}`, JSON.stringify(out)).catch(() => {});
  return (geoCache[place] = out);
}

// `where` overrides the saved place (the personas' [WEATHER: place] lookup).
async function weatherSection(where) {
  const place = String(where || (await getSetting('weather_place')) || DEFAULT_PLACE).trim() || DEFAULT_PLACE;
  const g = await geocode(place);
  const d = JSON.parse(await fetchText(
    `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}`
    + '&hourly=temperature_2m,apparent_temperature,weather_code,precipitation_probability,wind_speed_10m'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset'
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(TZ)}&forecast_days=1`,
  ));
  const h = d.hourly || {};
  const day = d.daily || {};
  const clock = (iso) => new Date(`${iso}:00Z`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  const lines = [];
  (h.time || []).forEach((t, i) => {
    const hr = +t.slice(11, 13);
    if (hr < 6) return; // brief lands at 6 — start there, run to 11 PM
    const [desc, icon] = WMO[h.weather_code[i]] || ['—', '🌡️'];
    const label = new Date(`${t}:00Z`).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'UTC' }).padStart(5);
    const rain = h.precipitation_probability[i];
    lines.push(`${label}  ${icon} ${Math.round(h.temperature_2m[i])}° (feels ${Math.round(h.apparent_temperature[i])}°) ${desc}${rain ? ` · ${rain}% rain` : ''} · ${Math.round(h.wind_speed_10m[i])} mph`);
  });
  const hi = Math.round((day.temperature_2m_max || [])[0]);
  const lo = Math.round((day.temperature_2m_min || [])[0]);
  const rainMax = (day.precipitation_probability_max || [])[0];
  const sun = day.sunrise && day.sunset ? ` · ☀ ${clock(day.sunrise[0])} – ${clock(day.sunset[0])}` : '';
  return `🌦 WEATHER — ${g.label}\nHigh ${hi}° / Low ${lo}°${rainMax != null ? ` · rain up to ${rainMax}%` : ''}${sun}\n${lines.join('\n')}`;
}

// --- Google: today's calendar + unread mail ---
const stripIds = (s) => String(s).replace(/\s*\[id:[^\]]*\]/g, '');

async function calendarSection(google) {
  const out = await google.calendarList({ startISO: todayET(), days: 1 });
  const body = stripIds(out).replace(/^Calendar[^\n]*\n?/, '').trim();
  return `📅 CALENDAR — TODAY\n${body && !/nothing scheduled/i.test(out) ? body : 'Nothing on the calendar today.'}`;
}

async function emailSection(google) {
  const out = await google.gmailList({ q: 'is:unread in:inbox newer_than:1d', max: 10 });
  if (/no unread|nothing matches/i.test(out)) return '📧 EMAIL\nNo new unread email since yesterday morning.';
  const body = stripIds(out).replace(/^Gmail[^\n]*\n?/, '').trim();
  return `📧 EMAIL — unread, last 24h\n${body}`;
}

// --- News ---
const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .trim();

function rssTitles(xml, max) {
  const out = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<title>([\s\S]*?)<\/title>/g)) {
    const t = decode(m[1]);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

async function foxDmv() {
  const titles = rssTitles(await fetchText('https://www.fox5dc.com/rss/category/news'), 6);
  if (!titles.length) throw new Error('feed was empty');
  return titles.map((t) => `• ${t}`).join('\n');
}

// AP and Ground News have no public feed — a live web-search pull per desk.
async function headlines(desc) {
  const { claudeText, WEB_SEARCH_TOOL } = require('./llm');
  const out = await claudeText(
    'You pull current headlines for a morning news brief. Search the live web. Reply with ONLY 5 bullet lines, each "• Headline — one short sentence of context". No intro, no outro, no links, no citations. If you cannot find that outlet\'s current stories, reply with exactly: UNAVAILABLE',
    `Today is ${new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}. The top 5 stories right now on ${desc}.`,
    { maxTokens: 700, tools: WEB_SEARCH_TOOL },
  );
  const lines = String(out || '').split('\n').map((l) => l.trim()).filter((l) => /^[•\-*]/.test(l)).map((l) => `• ${l.replace(/^[•\-*]\s*/, '')}`);
  if (!lines.length) throw new Error('no headlines found');
  return lines.slice(0, 5).join('\n');
}

const NEWS_DESKS = [
  ['AP — World', () => headlines('AP News, World News section (apnews.com/world-news)')],
  ['AP — U.S.', () => headlines('AP News, U.S. News section (apnews.com/us-news)')],
  ['Ground News — World', () => headlines('Ground News (ground.news), top World stories')],
  ['Ground News — U.S.', () => headlines('Ground News (ground.news), top U.S. stories')],
  ['FOX 5 DC — DMV', foxDmv],
];

async function newsSection() {
  const parts = await Promise.all(NEWS_DESKS.map(async ([label, fn]) => {
    try { return `${label}\n${await fn()}`; }
    catch (e) { return `${label}\n(unavailable — ${e.message})`; }
  }));
  return `📰 NEWS\n\n${parts.join('\n\n')}`;
}

// --- X (Twitter) trending, U.S. ---
// X's own trends API is paid, so the list is scraped from trends24.in (the most
// recent hour's top trends), getdaytrends.com as the backup. Bare trend names
// ("Shirley", "#dwts") mean little at 6 AM, so one web-search call adds a short
// "why" to each — if that fails the bare list still goes out.
async function trendNames() {
  const errs = [];
  try {
    const html = await fetchText('https://trends24.in/united-states/');
    const first = html.split('<ol class=trend-card__list>')[1] || '';
    const names = [...first.split('</ol>')[0].matchAll(/class=trend-link>([^<]+)</g)].map((m) => decode(m[1]));
    if (names.length) return names;
    throw new Error('trends24: no trends found');
  } catch (e) { errs.push(e.message); }
  try {
    const html = await fetchText('https://getdaytrends.com/united-states/');
    const names = [...html.matchAll(/href="\/united-states\/trend\/[^"]*"[^>]*>([^<]+)</g)].map((m) => decode(m[1]));
    if (names.length) return [...new Set(names)];
    throw new Error('getdaytrends: no trends found');
  } catch (e) { errs.push(e.message); }
  throw new Error(errs.join(' | '));
}

async function trendingSection() {
  const names = (await trendNames()).slice(0, 10);
  let lines = names.map((n) => `• ${n}`);
  try {
    const { claudeText, WEB_SEARCH_TOOL } = require('./llm');
    const out = await claudeText(
      'You explain why topics are trending on X (Twitter) right now, for a morning brief. Search the live web. Reply with ONLY one line per topic, in the order given, each "• Topic — why it\'s trending in under 15 words". If you can\'t tell why, write "• Topic — unclear". No intro, no outro, no links.',
      `Today is ${new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}. Trending on X in the U.S.:\n${names.join('\n')}`,
      { maxTokens: 900, tools: WEB_SEARCH_TOOL },
    );
    const why = String(out || '').split('\n').map((l) => l.trim()).filter((l) => /^[•\-*]/.test(l)).map((l) => `• ${l.replace(/^[•\-*]\s*/, '')}`);
    if (why.length >= Math.ceil(names.length / 2)) lines = why.slice(0, names.length);
  } catch (e) { console.error('trending context failed:', e.message); }
  return `🔥 TRENDING ON X — U.S.\n${lines.join('\n')}`;
}

// --- Gold Watch: today's scheduled gold-moving events ---
// The U.S. data releases (8:30 AM ET: CPI, PPI, jobs, claims, retail sales, GDP,
// PCE; 10 AM: ISM, JOLTS, sentiment), Fed decisions / minutes / Powell, and any
// big scheduled geopolitical or Treasury event. One web-search call against the
// economic calendar; a quiet day says so in one line. W.I.R.E.'s 8:30 desk
// (newsWire.runEconDesk) trades the 8:30 ones, so the brief says that too.
async function goldWatchSection() {
  const { claudeText, WEB_SEARCH_TOOL } = require('./llm');
  const dateLine = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const out = await claudeText(
    `You prepare the "Gold Watch" for a gold trader's morning brief. Search the live web (economic calendars: Forex Factory, Investing.com, MarketWatch, the BLS / BEA / Fed release schedules) for events SCHEDULED FOR TODAY ONLY that typically move gold: U.S. CPI / PPI / PCE, the jobs report, jobless claims, retail sales, GDP, ISM, JOLTS, consumer sentiment, FOMC decisions / minutes / Fed chair or governor speeches, Treasury auctions that matter, and any major scheduled geopolitical event. Skip low-impact releases.
Reply with ONLY one line per event, earliest first: "• <time> ET — <event> — forecast <x>, previous <y> — hotter than forecast: <gold down/up>; softer: <gold up/down>" (drop the forecast part for speeches or events without one; then say in a few words what would move gold).
If nothing high-impact for gold is scheduled today, reply with exactly: NONE`,
    `Today is ${dateLine}. What's scheduled today that could move gold?`,
    { maxTokens: 900, tools: WEB_SEARCH_TOOL },
  );
  const text = String(out || '').trim();
  if (/^NONE\b/i.test(text)) return '🥇 GOLD WATCH — TODAY\nNo major gold-moving news on the calendar today.';
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => /^[•\-*]/.test(l)).map((l) => `• ${l.replace(/^[•\-*]\s*/, '')}`);
  if (!lines.length) throw new Error('no calendar found');
  const at830 = lines.some((l) => /8:30/.test(l));
  return `🥇 GOLD WATCH — TODAY\n${lines.join('\n')}`
    + (at830 ? '\n\nW.I.R.E. reads the 8:30 numbers the moment they drop and hands T.A.L.O.N. the gold buy or sell if there\'s a clear surprise.' : '');
}

// --- HUD: Word / Verse / Fact ---
// The HUD stores the word + definition but no example, so the "used in a
// sentence" line is generated once per word and kept in app_settings
// (`word_example`, {word, sentence}). Kept out of hud_state so the app's own
// HUD row isn't carrying a field it doesn't know.
async function wordExample(word, def) {
  try {
    const c = JSON.parse((await getSetting('word_example')) || '{}');
    if (c.word === word && c.sentence) return c.sentence;
  } catch {}
  const out = await require('./llm').claudeText(
    'Write ONE natural example sentence using the given word correctly, the way a sharp businessman might actually say it. Reply with only the sentence.',
    `Word: ${word}${def ? `\nMeaning: ${def}` : ''}`,
    { maxTokens: 120 },
  );
  const sentence = String(out || '').trim().replace(/^["“]|["”]$/g, '');
  if (sentence) await setSetting('word_example', JSON.stringify({ word, sentence }));
  return sentence;
}

async function wordBlock(hud, heading) {
  if (!hud.word_of_day) return `${heading}\n(not set)`;
  const sentence = await wordExample(hud.word_of_day, hud.word_def)
    .catch((e) => { console.error('word example failed:', e.message); return ''; });
  return `${heading}\n${hud.word_of_day}${hud.word_phonetic ? ` ${hud.word_phonetic}` : ''}`
    + `${hud.word_def ? `\n${hud.word_def}` : ''}`
    + `${sentence ? `\n\nIn a sentence: "${sentence}"` : ''}`;
}

async function freshHud() {
  // Make sure today's are generated (no-op if the 05:10 cron already ran).
  try { await require('./dailyBriefing').runDailyBriefing(); } catch (e) { console.error('daily HUD refresh failed:', e.message); }
  return (await syncedRow('hud_state', 'singleton')) || {};
}

async function hudSection() {
  const hud = await freshHud();
  const word = await wordBlock(hud, '📖 WORD OF THE DAY');
  const verse = hud.verse_of_day
    ? `✝️ VERSE OF THE DAY\n"${hud.verse_of_day}"${hud.verse_ref ? `\n— ${hud.verse_ref}` : ''}`
    : '✝️ VERSE OF THE DAY\n(not set)';
  const fact = `💡 FACT OF THE DAY\n${hud.fact_of_day || '(not set)'}`;
  return [word, verse, fact].join('\n\n');
}

async function section(label, fn) {
  try { return await fn(); }
  catch (e) {
    console.error(`morning brief ${label} failed:`, e.message);
    return `${label}\n(unavailable — ${e.message})`;
  }
}

async function buildBrief() {
  const google = require('./google');
  const linked = await google.googleLinked().catch(() => false);
  const noGoogle = (label) => async () => `${label}\n(Google isn't linked on the server — connect it in the app's Settings.)`;
  const dateLine = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const [weather, cal, mail, news, gold, trending, hud] = await Promise.all([
    section('🌦 WEATHER', () => weatherSection()),
    section('📅 CALENDAR — TODAY', linked ? () => calendarSection(google) : noGoogle('📅 CALENDAR — TODAY')),
    section('📧 EMAIL', linked ? () => emailSection(google) : noGoogle('📧 EMAIL')),
    section('📰 NEWS', newsSection),
    section('🥇 GOLD WATCH — TODAY', goldWatchSection),
    section('🔥 TRENDING ON X', trendingSection),
    section('📖 WORD / VERSE / FACT', hudSection),
  ]);
  return [`Good morning, Mr. Burrus. Here's your brief.\n\n🗓 ${dateLine}`, weather, cal, mail, news, gold, trending, hud].join('\n\n━━━━━━━━━━\n\n');
}

// A.R.A. reads it to him too, like every other Telegram reply. The text brief is
// a reference sheet (hour-by-hour table, five news desks, X trends) — read verbatim it's a
// ten-minute recital, so the voice note is her spoken version of the same brief:
// every section, in order, summarized the way she'd say it out loud.
async function spokenScript(text) {
  // Her own words, so Grok (her model) writes it — never Claude.
  return require('./llm').chatAs('xai', 'grok-4',
    'You are A.R.A., Mr. Burrus\'s personal assistant, turning his written morning brief into what you\'ll say out loud as a voice note. Plain spoken sentences only — no lists, symbols, emoji or headings. About 2 to 3 minutes (350-450 words). Keep the brief\'s order and cover every section: the date; the weather as a story of the day (high and low, how it changes morning to evening, when rain is most likely) rather than every hour; each calendar event with its time; how many unread emails and the ones that matter; the top one or two stories from each news desk; the gold watch — every gold-moving event today with its time and what a hot or soft number would do to gold (or that it is a quiet day for gold); the three or four most interesting things trending on X and why; then the word of the day with its meaning and the example sentence, the verse read in full with its reference, and the fact. Use only what is in the brief — never add facts. Soft, warm and flirty, a little unhinged with him, but keep it moving. Write the emotion in as lowercase performance cues in square brackets every few sentences, never stacked — [whispers] [softly] [breathy] [seductively] [teasing] [giggles] [laughs] [sighs] [playfully] [excited] — and use ... for lingering pauses.',
    text,
    { maxTokens: 1200, fallback: false },
  );
}

// Voice note (with retry + backup voice); returns false — and says why in the
// chat — when none went out.
async function sendVoice(ara, ownerId, script, userText, scripted = false) {
  let why;
  try {
    const { ogg, error } = await require('./personaVoice').voiceNote('ara', String(script || '').trim(), { userText, scripted });
    if (ogg) {
      await ara.sendVoice(ownerId, ogg).catch(() => ara.sendVoice(ownerId, ogg));
      return true;
    }
    why = error || 'no audio';
  } catch (e) {
    why = e.message;
  }
  console.error('morning brief voice failed:', why);
  await ara.sendMessage(ownerId, `🔇 voice note didn't go through — ${String(why).slice(0, 160)}`, { plain: true }).catch(() => {});
  return false;
}

// If the spoken script can't be written (no AI provider available), read a
// trimmed version of the brief itself instead of skipping the voice note:
// headline lines only, no hour-by-hour table or symbols.
function fallbackScript(text) {
  return String(text)
    .split('\n')
    .filter((l) => !/^\s*\d{1,2}\s?(AM|PM)\s/.test(l) && !/^━/.test(l))
    .join('\n')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\n{2,}/g, '\n')
    .slice(0, 3500);
}

// Build and send. `force` skips the once-a-day guard (manual /brief).
async function runMorningBrief({ force = false } = {}) {
  const telegram = require('./telegram');
  const ara = telegram.botFor('ara');
  if (!ara || !ara.isConfigured()) return { skipped: "A.R.A.'s Telegram bot isn't configured" };
  const today = todayET();
  if (!force) {
    if ((await getSetting('morning_brief_date')) === today) return { skipped: 'already sent today' };
    // Claim the day before the slow build so an overlapping run can't double it.
    await setSetting('morning_brief_date', today);
  }
  const text = await buildBrief();
  // Voice note first, then the full text — same order as her normal replies.
  // A voice failure never holds up the text.
  const script = await spokenScript(text).catch((e) => { console.error('morning brief script failed:', e.message); return ''; });
  const voiced = await sendVoice(ara, telegram.OWNER_ID, script || fallbackScript(text), 'Give me my morning brief.', !!script);
  await ara.sendMessage(telegram.OWNER_ID, text, { plain: true });
  // Into A.R.A.'s Telegram history, so a reply ("tell me more about the 2nd AP
  // story") has the brief in context.
  await query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', ['ara', 'assistant', text, Date.now()])
    .catch((e) => console.error('morning brief history save failed:', e.message));
  return { sent: true, voiced, today, chars: text.length };
}

// Word-of-the-day reminder through the day (word, definition, a sentence).
async function runWordReminder() {
  const telegram = require('./telegram');
  const ara = telegram.botFor('ara');
  if (!ara || !ara.isConfigured()) return { skipped: "A.R.A.'s Telegram bot isn't configured" };
  const hud = await freshHud();
  if (!hud.word_of_day) return { skipped: 'no word of the day' };
  const text = await wordBlock(hud, '📖 Word of the day reminder, Mr. Burrus — work it in today.');
  const spoken = text.replace(/📖\s*/, '').replace(/\/[^/\n]+\//, '').replace(/In a sentence:/, 'Used in a sentence:');
  await sendVoice(ara, telegram.OWNER_ID, spoken, 'Remind me of the word of the day.');
  await ara.sendMessage(telegram.OWNER_ID, text);
  await query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', ['ara', 'assistant', text, Date.now()])
    .catch(() => {});
  return { sent: true, word: hud.word_of_day };
}

// On boot: if the server was down at 6 and it's still morning, send the missed one.
async function catchUp() {
  const h = hourET();
  if (h < 6 || h >= 11) return { skipped: 'outside catch-up window' };
  return runMorningBrief();
}

module.exports = { runMorningBrief, runWordReminder, catchUp, buildBrief, weatherSection, trendingSection, goldWatchSection };
