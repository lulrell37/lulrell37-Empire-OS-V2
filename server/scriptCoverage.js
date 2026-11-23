// Did her spoken script keep the facts? Pure code, no AI.
// mustSay(text) pulls the facts a voice note can't drop (numbers, price levels,
// times, percents, persona and market names); missingFrom(script, items) says
// which of them the script doesn't say, in digits or as spoken words
// ("4,215", "4215", "forty-two fifteen", "four thousand two hundred fifteen").
// node server/scripts/test-ara-relay.js

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function words(n) { // 0..999999
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ''}`;
  return `${words(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${words(n % 1000)}` : ''}`;
}

const digitWords = (s) => [...s].map((d) => ONES[+d]).join(' ');

// Every way a whole number may be said.
function intForms(digits) {
  const n = Number(digits);
  if (!Number.isFinite(n) || digits.length > 6) return [digits];
  const forms = [digits, words(n)];
  if (n >= 1000 && n % 1000 !== 0 || n >= 1100) {
    const a = Math.floor(n / 100), b = n % 100; // 4215 -> "forty two fifteen"
    if (digits.length === 4) {
      forms.push(b === 0 ? `${words(a)} hundred` : b < 10 ? `${words(a)} oh ${ONES[b]}` : `${words(a)} ${words(b)}`);
      if (b > 0 && b < 10) forms.push(`${words(a)} zero ${ONES[b]}`);
    }
  }
  if (n >= 1000 && n < 10000) forms.push(`${words(Math.floor(n / 1000))} thousand`); // loosely "two thousand"
  forms.push(digitWords(digits));
  return forms;
}

// "4,215.50" / "0.8" -> spoken forms
function numberForms(raw) {
  const clean = raw.replace(/,/g, '');
  const [i, f] = clean.split('.');
  const out = [];
  const ints = intForms(i);
  if (f === undefined) return ints;
  const frac = [f, digitWords(f)];
  if (f.length === 2 && +f % 10 === 0) frac.push(f[0], ONES[+f[0]]); // .50 -> "point five"
  if (f.length === 2) frac.push(words(+f)); // "four thousand two hundred fifteen fifty"
  for (const a of ints) for (const b of frac) out.push(`${a} point ${b}`, `${a}.${b}`);
  if (+f === 0) out.push(...ints);
  if (+i === 0) for (const b of frac) out.push(`point ${b}`, `.${b}`);
  return out;
}

const norm = (s) => String(s || '').toLowerCase()
  .replace(/(\d),(?=\d{3}\b)/g, '$1')
  .replace(/[-–—]/g, ' ')
  .replace(/[^a-z0-9.: ]+/g, ' ')
  .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
  .replace(/\s+/g, ' ');

// Persona names as she says them, and the markets as she'd name them.
const MARKETS = [
  [/\bXAU\/?USD\b|\bXAUUSD\b/, 'XAUUSD', ['xauusd', 'gold']],
  [/\bBTC\/?USD\b|\bBTCUSD\b/, 'BTCUSD', ['btcusd', 'bitcoin', 'btc']],
  [/\b(?:NAS100|US100|USTEC)\b/, 'NAS100', ['nas100', 'us100', 'ustec', 'nasdaq']],
];

function personaNames(text) {
  const { ROSTER } = require('./personas');
  const { speakNames } = require('./voiceCues');
  const out = [];
  for (const [id, p] of Object.entries(ROSTER)) {
    if (id === 'ara') continue;
    const said = speakNames(p.name).replace(/\.$/, '');
    const dotted = p.name.replace(/\./g, '\\.?');
    if (new RegExp(`(?<![A-Za-z])(?:${dotted}|${said})(?![A-Za-z])`, 'i').test(text) && /^[A-Za-z]/.test(said)) out.push({ kind: 'name', show: said, forms: [said.toLowerCase(), id] });
  }
  return out;
}

const MAX_ITEMS = 30;

function mustSay(text) {
  const s = String(text || '');
  const items = [], seen = new Set();
  const add = (key, item) => { if (!seen.has(key) && items.length < MAX_ITEMS) { seen.add(key); items.push(item); } };
  const found = [];
  // times: 9:30 AM, 3:30 PM ET, 8 PM
  for (const m of s.matchAll(/(?<![\d:.])(\d{1,2}):(\d{2})\s?([AaPp]\.?[Mm]\.?)?|(?<![\d:.$])(\d{1,2})\s?([AaPp]\.?[Mm]\.?)(?![A-Za-z])/g)) {
    found.push({ at: m.index, end: m.index + m[0].length, kind: 'time', m });
  }
  // numbers: $-amounts, percents, anything 3+ digits or with a comma/decimal
  for (const m of s.matchAll(/(\$)?(?<![\d:.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?%|\s?percent)?(?![\d:])/g)) {
    const raw = m[2] + (m[3] || '');
    const plain = raw.replace(/,/g, '');
    const big = m[1] || m[4] || m[3] || m[2].includes(',') || plain.length >= 3;
    const isYear = !m[1] && !m[4] && !m[3] && /^20[2-3]\d$/.test(plain);
    const dateBit = /[-/]\d{1,2}[-/]?$/.test(s.slice(Math.max(0, m.index - 3), m.index)) || /^[-/]\d/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 2));
    if (!big || isYear || dateBit) continue;
    found.push({ at: m.index, end: m.index + m[0].length, kind: m[4] ? 'percent' : 'number', m, raw });
  }
  found.sort((a, b) => a.at - b.at);
  let last = -1;
  for (const f of found) {
    if (f.at < last) continue; // a time's digits aren't also numbers
    last = f.end;
    if (f.kind === 'time') {
      const h = f.m[1] || f.m[4], min = f.m[2] || '00', ap = (f.m[3] || f.m[5] || '').replace(/\./g, '').toLowerCase();
      const hh = String(+h);
      const forms = [`${hh}:${min}`, `${hh} ${min}`, `${hh}${min}`];
      const hw = words(+hh);
      if (min === '00') forms.push(hw, hh);
      else forms.push(+min < 10 ? `${hw} oh ${ONES[+min]}` : `${hw} ${words(+min)}`);
      add(`t${hh}:${min}${ap}`, { kind: 'time', show: `${hh}:${min}${ap ? ` ${ap.toUpperCase()}` : ''}`.replace(':00 ', ' ').replace(/^(\d+):00$/, '$1'), forms, loose: true });
    } else {
      const forms = numberForms(f.raw);
      const dollar = f.m[1] ? '$' : '';
      add(`n${f.raw.replace(/,/g, '')}`, { kind: f.kind, show: `${dollar}${f.raw}${f.m[4] ? ' percent' : ''}`, forms });
    }
  }
  for (const [re, show, forms] of MARKETS) if (re.test(s)) add(`m${show}`, { kind: 'name', show: forms[1], forms });
  for (const p of personaNames(s)) add(`p${p.show}`, p);
  return items;
}

// Items the script doesn't say. Numbers need a whole-token match, so "42" isn't
// found inside "4215"; names are plain substrings.
function missingFrom(script, items) {
  const t = ` ${norm(script)} `;
  return items.filter((it) => !it.forms.some((f) => {
    const g = norm(f).trim();
    if (!g) return false;
    if (it.kind === 'name') return t.includes(g);
    return t.includes(` ${g} `) || t.includes(` ${g}.`) || (/\d/.test(g) && new RegExp(`(?<![\\d])${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`).test(t));
  }));
}

const listFacts = (items) => items.map((i) => i.show).join(', ');

module.exports = { mustSay, missingFrom, listFacts, MAX_ITEMS };
