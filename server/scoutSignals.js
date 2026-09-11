// Free buying-intent signal sources for the server-side S.C.O.U.T. cron.
//
// Each source is independent and best-effort: a failure logs and returns []. A
// signal is a normalized candidate:
//   { name, business, website, contact, segment, signal, signalType, signalAt }
// where `signal` is a one-line human string ("hiring a dispatcher"), signalType
// is a short slug for scoring, and signalAt is an epoch ms.
const { HIRING_SIGNAL_ROLES, cityOf } = require('./scoutTargets');

const DAY = 86400000;

// ---- job postings (Adzuna) ----------------------------------------------
// https://developer.adzuna.com/ — free tier, ADZUNA_APP_ID / ADZUNA_APP_KEY.
// A small business hiring a phone/scheduling/intake role is stating an
// operational bottleneck out loud.
async function adzunaHiringSignals({ metro, segment, maxDaysOld = 21, perRole = 5 }) {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return [];
  const where = cityOf(metro);
  const out = [];
  // A couple of roles per cycle keeps well inside the free 250 calls/day.
  for (const role of HIRING_SIGNAL_ROLES.slice(0, 3)) {
    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1`
      + `?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}`
      + `&what=${encodeURIComponent(role)}&where=${encodeURIComponent(where)}`
      + `&results_per_page=20&max_days_old=${maxDaysOld}&content-type=application/json`;
    let j;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.error(`scoutSignals adzuna ${res.status}`); continue; }
      j = await res.json();
    } catch (e) { console.error('scoutSignals adzuna:', e.message); continue; }
    for (const r of (j.results || []).slice(0, perRole)) {
      const company = r.company && r.company.display_name;
      if (!company || /staffing|recruit|talent|temp agency|indeed|ziprecruiter/i.test(company)) continue;
      out.push({
        name: company,
        business: `${company} — hiring in ${where}`,
        website: '',
        contact: '',
        segment: `${segment} · ${metro}`,
        signal: `hiring a ${role}${r.title ? ` ("${String(r.title).slice(0, 80)}")` : ''}`,
        signalType: 'hiring',
        signalAt: r.created ? Date.parse(r.created) || Date.now() : Date.now(),
        _raw: { title: r.title, desc: String(r.description || '').slice(0, 400), url: r.redirect_url },
      });
    }
  }
  return dedupeByName(out);
}

// ---- review velocity (Yelp Fusion) -------------------------------------
// https://docs.developer.yelp.com/ — free tier, YELP_API_KEY. A cluster of
// recent low-star reviews mentioning phones / booking / no-shows is a
// service-capacity signal.
const CAPACITY_RE = /phone|answer|call ?back|voicemail|hold|booking|book an|appointment|reschedul|no.?show|never (got|call)|couldn'?t (reach|get)|left a message/i;

async function yelpReviewSignals({ metro, segment, perCell = 8 }) {
  const key = process.env.YELP_API_KEY;
  if (!key) return [];
  const headers = { authorization: `Bearer ${key}` };
  const location = cityOf(metro);
  let businesses = [];
  try {
    const res = await fetch(
      `https://api.yelp.com/v3/businesses/search?term=${encodeURIComponent(segment)}&location=${encodeURIComponent(location)}&limit=20&sort_by=review_count`,
      { headers },
    );
    if (!res.ok) { console.error(`scoutSignals yelp search ${res.status}`); return []; }
    businesses = (await res.json()).businesses || [];
  } catch (e) { console.error('scoutSignals yelp search:', e.message); return []; }

  const candidates = businesses
    .filter((b) => !b.is_closed && Number(b.review_count) >= 10 && Number(b.rating) <= 3.5)
    .slice(0, perCell);

  const out = [];
  for (const b of candidates) {
    let reviews = [];
    try {
      const res = await fetch(`https://api.yelp.com/v3/businesses/${b.id}/reviews?sort_by=newest&limit=20`, { headers });
      if (res.ok) reviews = (await res.json()).reviews || [];
    } catch (e) { /* excerpt endpoint is flaky on free tier — fall through */ }
    const recentBad = reviews.filter((r) => Number(r.rating) <= 2 && CAPACITY_RE.test(r.text || ''));
    // Yelp only returns ~3 excerpts on the free tier, so "2 of the recent set"
    // is the bar; the low overall rating already did most of the filtering.
    if (recentBad.length < 2 && !(reviews.length && recentBad.length >= 1 && Number(b.rating) <= 2.5)) continue;
    out.push({
      name: b.name,
      business: b.name,
      website: b.url ? b.url.split('?')[0] : '',
      contact: b.phone || b.display_phone || '',
      segment: `${segment} · ${metro}`,
      signal: `${b.rating}★ over ${b.review_count} reviews; recent ones cite missed calls / booking (${recentBad.length} flagged)`,
      signalType: 'reviews',
      signalAt: recentBad[0] && recentBad[0].time_created ? Date.parse(recentBad[0].time_created) || Date.now() : Date.now(),
      _raw: { quotes: recentBad.slice(0, 2).map((r) => String(r.text || '').slice(0, 200)) },
    });
  }
  return out;
}

// ---- new business formation ------------------------------------------
// Placeholder — state registries mostly need per-state scrapers; wire them in
// here as they're built. Returns [] for now so the cron composes cleanly.
async function newBusinessSignals() {
  return [];
}

function dedupeByName(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = String(r.name || '').toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Heat 0-100 from signal type + recency + count. Deliberately simple.
function heatFor({ signalType, signalAt, count = 1 }) {
  const base = { hiring: 55, reviews: 45, formation: 40 }[signalType] || 30;
  const ageDays = Math.max(0, (Date.now() - (signalAt || Date.now())) / DAY);
  const recency = ageDays < 3 ? 25 : ageDays < 7 ? 18 : ageDays < 14 ? 10 : ageDays < 30 ? 4 : 0;
  const volume = Math.min(15, (count - 1) * 6);
  return Math.max(1, Math.min(100, Math.round(base + recency + volume)));
}

// All sources for one grid cell, flattened.
async function gatherSignals(cell) {
  const [jobs, reviews, formations] = await Promise.all([
    adzunaHiringSignals(cell).catch((e) => { console.error('adzuna:', e.message); return []; }),
    yelpReviewSignals(cell).catch((e) => { console.error('yelp:', e.message); return []; }),
    newBusinessSignals(cell).catch(() => []),
  ]);
  return [...jobs, ...reviews, ...formations];
}

module.exports = { gatherSignals, heatFor, adzunaHiringSignals, yelpReviewSignals };
