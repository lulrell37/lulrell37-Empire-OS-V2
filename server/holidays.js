// Holidays every persona knows (owner, 2026-11-26: "I want Ara to be able to see holidays
// and stuff, she just sees my calendar stuff. Today is Thanksgiving, so she should know
// it's Thanksgiving. Maybe say happy Thanksgiving. All personas should know holidays").
//
// Pure code, no API, no key: US federal holidays (with the observed weekday when one
// falls on a weekend), the big observances (Easter, Mother's / Father's Day, Halloween,
// Black Friday…), the clock changes, the US stock market's closed and early-close days,
// and, where the runtime's Intl has the calendars (the server's Node does), Hanukkah,
// Ramadan and the two Eids. holidayLine() goes in every persona's CURRENT MOMENT line,
// Telegram and app (src/services/holidays.js is the same code between the markers;
// node server/scripts/test-holidays.js fails if they drift).
// --- shared: start ---
const DAY = 86400000;
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// The nth (1-based; -1 = last) weekday (0 = Sun) of a month.
function nthWeekday(y, m, wd, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return lastDay - ((last - wd + 7) % 7);
}
// Easter Sunday (Anonymous Gregorian computus).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}
const shift = (y, m, d, n) => { const t = new Date(Date.UTC(y, m - 1, d) + n * DAY); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };
// A fixed-date federal holiday on a Saturday is observed Friday, on a Sunday Monday.
function observed(y, m, d) {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 6 ? shift(y, m, d, -1) : wd === 0 ? shift(y, m, d, 1) : null;
}
// Dates from another calendar (hebrew / islamic-umalqura), if this runtime's Intl has it.
function otherCalendar(y, cal, want) {
  const out = [];
  let fmt;
  try { fmt = new Intl.DateTimeFormat(`en-US-u-ca-${cal}`, { timeZone: 'UTC', month: 'long', day: 'numeric' }); } catch { return out; }
  for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += DAY) {
    let parts;
    try { parts = fmt.formatToParts(new Date(t)); } catch { return out; }
    const month = (parts.find((p) => p.type === 'month') || {}).value || '';
    const day = Number((parts.find((p) => p.type === 'day') || {}).value);
    for (const [name, mo, dd, note] of want) {
      if (mo.test(month) && day === dd) { const x = new Date(t); out.push({ date: ymd(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()), name, note }); }
    }
  }
  return out;
}
// Every holiday in year y: { date: 'YYYY-MM-DD', name, note }. note: federal / market / ''.
function holidaysIn(y) {
  const H = [];
  const add = (m, d, name, note = '') => H.push({ date: ymd(y, m, d), name, note });
  const fed = (m, d, name, extra = '') => {
    add(m, d, name, `US federal holiday${extra}`);
    const o = observed(y, m, d);
    if (o) H.push({ date: ymd(o[0], o[1], o[2]), name: `${name} (observed)`, note: `federal day off${extra}` });
  };
  fed(1, 1, 'New Year\'s Day', '; stock market closed');
  add(1, nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day', 'US federal holiday; stock market closed');
  add(2, 2, 'Groundhog Day');
  add(2, 14, 'Valentine\'s Day');
  add(2, nthWeekday(y, 2, 1, 3), 'Presidents\' Day', 'US federal holiday; stock market closed');
  add(3, 17, 'St. Patrick\'s Day');
  add(3, nthWeekday(y, 3, 0, 2), 'Daylight saving time starts (clocks forward an hour)');
  const [em, ed] = easter(y);
  const gf = shift(y, em, ed, -2);
  H.push({ date: ymd(gf[0], gf[1], gf[2]), name: 'Good Friday', note: 'stock market closed' });
  add(em, ed, 'Easter Sunday');
  add(5, nthWeekday(y, 5, 0, 2), 'Mother\'s Day');
  add(5, nthWeekday(y, 5, 1, -1), 'Memorial Day', 'US federal holiday; stock market closed');
  add(6, nthWeekday(y, 6, 0, 3), 'Father\'s Day');
  fed(6, 19, 'Juneteenth', '; stock market closed');
  fed(7, 4, 'Independence Day', '; stock market closed');
  add(9, nthWeekday(y, 9, 1, 1), 'Labor Day', 'US federal holiday; stock market closed');
  add(10, nthWeekday(y, 10, 1, 2), 'Columbus Day / Indigenous Peoples\' Day', 'US federal holiday (stock market open)');
  add(10, 31, 'Halloween');
  add(11, nthWeekday(y, 11, 0, 1), 'Daylight saving time ends (clocks back an hour)');
  fed(11, 11, 'Veterans Day', ' (stock market open)');
  const tg = nthWeekday(y, 11, 4, 4);
  add(11, tg, 'Thanksgiving Day', 'US federal holiday; stock market closed');
  const bf = shift(y, 11, tg, 1), cm = shift(y, 11, tg, 4);
  H.push({ date: ymd(bf[0], bf[1], bf[2]), name: 'Black Friday', note: 'stock market closes early, 1 PM ET' });
  H.push({ date: ymd(cm[0], cm[1], cm[2]), name: 'Cyber Monday', note: '' });
  add(12, 24, 'Christmas Eve', new Date(Date.UTC(y, 11, 24)).getUTCDay() % 6 && new Date(Date.UTC(y, 11, 25)).getUTCDay() !== 6 ? 'stock market closes early, 1 PM ET' : '');
  fed(12, 25, 'Christmas Day', '; stock market closed');
  add(12, 26, 'Kwanzaa begins');
  add(12, 31, 'New Year\'s Eve');
  H.push(...otherCalendar(y, 'hebrew', [['Hanukkah begins (at sundown the evening before)', /^kislev/i, 25, '']]));
  H.push(...otherCalendar(y, 'islamic-umalqura', [['Ramadan begins (dates can shift a day with the moon)', /^ramadan/i, 1, ''], ['Eid al-Fitr', /^shaww?al/i, 1, ''], ['Eid al-Adha', /^dhu.*hi[jj]/i, 10, '']]));
  return H.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
const etYmd = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
// Today's holidays and the ones in the next `days`.
function holidaysAround(now = Date.now(), days = 21) {
  const today = etYmd(now);
  const end = etYmd(now + days * DAY);
  const y = Number(today.slice(0, 4));
  const all = [...holidaysIn(y), ...holidaysIn(y + 1)];
  return { today: all.filter((h) => h.date === today), soon: all.filter((h) => h.date > today && h.date <= end) };
}
const nice = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); };
function holidayLine(now = Date.now()) {
  const { today, soon } = holidaysAround(now);
  const t = today.map((h) => `${h.name}${h.note ? ` (${h.note})` : ''}`).join(' and ');
  const s = soon.map((h) => `${h.name} ${nice(h.date)}${h.note ? ` (${h.note})` : ''}`).join('; ');
  return `[HOLIDAYS — ${t ? `TODAY IS ${t}. If it's one he'd celebrate, wish him a happy one in your own words the first time you talk to him today (once a day — if you already did today, don't repeat it), and keep it in mind for anything about today.` : 'no holiday today.'}${s ? ` Coming up: ${s}.` : ''} Use these for "what day is it", plans, deliveries, the markets and anything else a holiday changes.]`;
}
// --- shared: end ---

module.exports = { holidaysIn, holidaysAround, holidayLine, easter, nthWeekday };
