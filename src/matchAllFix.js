// String.prototype.matchAll, replaced with a plain exec loop.
//
// On the phone (Hermes, RN 0.74) the built-in matchAll threw "Object is not a
// function" partway through a persona's turn — decoded from the crash log to the
// `[...response.matchAll(...)]` call in CommandScreen.js — and every reply died
// with "Something went wrong". The app uses matchAll ~80 times to find its
// command tags, so instead of touching each call it gets one implementation
// that needs nothing but RegExp.prototype.exec: no Symbol.matchAll, no species
// constructor, no new RegExp. Same results as the spec for the global regexes
// the app passes (each match array with .index / .input / groups).
// Imported first thing in index.js, before anything else runs.
export function matchAllExec(str, re) {
  const s = String(str);
  if (typeof re === 'string') re = new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  if (!re || typeof re.exec !== 'function') throw new TypeError('matchAll needs a RegExp');
  if (!re.global) throw new TypeError('String.prototype.matchAll called with a non-global RegExp argument');
  // Like the spec (which clones the regex): start at its lastIndex, leave it as it was.
  const saved = re.lastIndex;
  const out = [];
  try {
    let m;
    while ((m = re.exec(s)) !== null) {
      out.push(m);
      if (m[0] === '') { // zero-length match: step past it (a whole code point on a /u regex)
        const i = re.lastIndex;
        const c = s.charCodeAt(i);
        re.lastIndex = i + (re.unicode && c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1);
      }
    }
  } finally {
    re.lastIndex = saved;
  }
  return out[Symbol.iterator]();
}

// Every match as an array, for the reply loop's tag scans. Takes anything
// (coerced to text), never looks a method up on it and never spreads an
// iterator: the phone kept failing on `[...response.matchAll(...)]` itself.
export function allMatches(text, re) {
  const it = matchAllExec(typeof text === 'string' ? text : String(text ?? ''), re);
  const out = [];
  for (let r = it.next(); !r.done; r = it.next()) out.push(r.value);
  return out;
}

try {
  Object.defineProperty(String.prototype, 'matchAll', {
    value: function matchAll(re) { return matchAllExec(this, re); },
    writable: true,
    configurable: true,
    enumerable: false,
  });
} catch (e) { /* leave the built-in in place */ }
