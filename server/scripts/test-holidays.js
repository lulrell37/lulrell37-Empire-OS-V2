// Holidays every persona knows (server/holidays.js, src/services/holidays.js).
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const h = require('../holidays');
const on = (y, name) => h.holidaysIn(y).filter((x) => x.name === name).map((x) => x.date);
assert.deepStrictEqual(on(2026, 'Thanksgiving Day'), ['2026-11-26']);
assert.deepStrictEqual(on(2027, 'Thanksgiving Day'), ['2027-11-25']);
assert.deepStrictEqual(on(2026, 'Easter Sunday'), ['2026-04-05']);
assert.deepStrictEqual(on(2027, 'Easter Sunday'), ['2027-03-28']);
assert.deepStrictEqual(on(2026, 'Memorial Day'), ['2026-05-25']);
assert.deepStrictEqual(on(2026, 'Martin Luther King Jr. Day'), ['2026-01-19']);
assert.deepStrictEqual(on(2026, 'Independence Day (observed)'), ['2026-07-03']);
assert.deepStrictEqual(on(2026, 'Black Friday'), ['2026-11-27']);
// Thanksgiving 2026, noon ET: today and what's next, with the market notes.
const line = h.holidayLine(Date.UTC(2026, 10, 26, 17));
assert.match(line, /TODAY IS Thanksgiving Day \(US federal holiday; stock market closed\)/);
assert.match(line, /wish him a happy one/);
assert.match(line, /Black Friday Fri, Nov 27 \(stock market closes early/);
assert.match(h.holidayLine(Date.UTC(2026, 10, 20, 17)), /no holiday today[\s\S]*Thanksgiving Day Thu, Nov 26/);
// The app's copy is the same code.
const cut = (t) => t.slice(t.indexOf('// --- shared: start ---'), t.indexOf('// --- shared: end ---'));
const srv = fs.readFileSync(path.join(__dirname, '../holidays.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../../src/services/holidays.js'), 'utf8');
assert.strictEqual(cut(app), cut(srv), 'src/services/holidays.js drifted from server/holidays.js');
// Every persona's Telegram prompt and relay prompt carry it, and the app's buildSys.
const rt = fs.readFileSync(path.join(__dirname, '../personaRuntime.js'), 'utf8');
assert.strictEqual((rt.match(/require\('\.\/holidays'\)\.holidayLine\(\)/g) || []).length, 3);
assert.match(fs.readFileSync(path.join(__dirname, '../../src/services/aiService.js'), 'utf8'), /holidayLine\(\)/);
console.log('holidays: all checks passed');
