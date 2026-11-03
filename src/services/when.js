// Tolerant date/time reading for calendar tags — what a persona actually writes,
// not just "2026-11-06T15:00": "2026-11-06 3pm", date and time in separate
// fields, "Friday 3pm", "tomorrow at 10:30am", "Nov 6 2pm", "11/6 at 3",
// "noon". Mirrors server/when.js (keep in sync).
//
//
// parseWhen(text, today) -> { y, m, d, hh, mm, allDay } | null
//   today = { y, m, d, wd } (wd 0 = Sunday) — the caller's "today" in his time zone.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function parseWhen(input, today) {
  let s = String(input || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let date = null;
  let m;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    date = { y: +m[1], m: +m[2], d: +m[3] };
    s = s.replace(m[0], ' ').replace(/^\s*t(?=\d)/, ' ');
  } else if ((m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/))) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    let y = m[3] ? +m[3] : today.y;
    if (!m[3] && (mo < today.m || (mo === today.m && +m[2] < today.d))) y += 1;
    date = { y, m: mo, d: +m[2] };
    s = s.replace(m[0], ' ');
  } else if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    let y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : today.y;
    if (!m[3] && (+m[1] < today.m || (+m[1] === today.m && +m[2] < today.d))) y += 1;
    date = { y, m: +m[1], d: +m[2] };
    s = s.replace(m[0], ' ');
  } else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) {
    date = { y: today.y, m: today.m, d: today.d };
  } else if (/\btomorrow\b/.test(s)) {
    date = addDays(today, 1);
  } else {
    const w = DAYS.findIndex((d) => new RegExp(`\\b${d}[a-z]*\\b`).test(s));
    if (w >= 0) {
      let diff = (w - today.wd + 7) % 7;
      if (diff === 0) diff = 7; // "Friday" said on a Friday = next week's
      date = addDays(today, diff);
    }
  }
  if (!date || date.m < 1 || date.m > 12 || date.d < 1 || date.d > 31) return null;

  let hh = null;
  let mm = 0;
  if (/\bnoon\b/.test(s)) hh = 12;
  else if (/\bmidnight\b/.test(s)) hh = 0;
  else if ((m = s.match(/(?:^|[^\d])(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?![\d])/g))) {
    // Pick the token that's really a time: has minutes or am/pm, or follows "at".
    const toks = [...s.matchAll(/(at\s+)?(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?![\d])/g)]
      .filter((t) => t[3] || t[4] || t[1]);
    const t = toks[0];
    if (t) {
      hh = +t[2];
      mm = t[3] ? +t[3] : 0;
      const ap = t[4] ? t[4].replace(/[\s.]/g, '') : '';
      if (ap === 'pm' && hh < 12) hh += 12;
      if (ap === 'am' && hh === 12) hh = 0;
      // "at 3" with no am/pm: business hours read — 1-7 means afternoon.
      if (!ap && !t[3] && hh >= 1 && hh <= 7) hh += 12;
    }
  }
  if (hh != null && (hh > 23 || mm > 59)) return null;
  if (hh == null && /\b(morning)\b/.test(s)) hh = 9;
  if (hh == null && /\b(afternoon)\b/.test(s)) hh = 14;
  if (hh == null && /\b(evening|tonight)\b/.test(s)) hh = 19;
  return { ...date, hh: hh == null ? null : hh, mm, allDay: hh == null };
}

export { parseWhen, addDays };
