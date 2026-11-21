// node server/scripts/test-own-messages.js — what a bot sends him on its own
// (alerts, clip results, briefs) is saved in that persona's history, marked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../telegram');

const line = T.ownLine('🎬 R.O.G.U.E.\'s auto clip didn\'t work: yt-dlp blocked', Date.parse('2026-11-21T12:25:00Z'));
assert.ok(line.startsWith(`${T.OWN_MARK}, Sat 7:25 AM ET — not a reply to him]\n`), line);
assert.ok(line.endsWith("didn't work: yt-dlp blocked"));
assert.ok(T.ownLine('x'.repeat(9000)).length < 6200, 'long ones trimmed');

// Turn replies are saved by the turn, so they must not be saved twice; the
// senders that used to save their own copy now rely on the bot.
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.ok(/deliver\(tail \? `\$\{reply\}\\n\\n\$\{tail\}` : reply, \{ log: false \}\)/.test(src('routes/telegram.js')), 'turn reply not double-saved');
assert.ok(!/sendFile\(chatId, [^\n]*\{ (?!log: false)/.test(src('telegramMedia.js')), 'turn media not double-saved');
for (const f of ['talonAlerts.js', 'morningBrief.js', 'buildAgent.js', 'seleneTrends.js']) assert.ok(!/INSERT INTO tg_messages/.test(src(f)), `${f} doesn't save a second copy`);
assert.ok(src('personaRuntime.js').includes('[SENT ON YOUR OWN'), 'her prompt knows the mark');
console.log('own messages: all checks passed');
