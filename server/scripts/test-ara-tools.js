// A.R.A.'s prompt lists every tag her code paths accept (she once said she couldn't
// transcribe a reel). node server/scripts/test-ara-tools.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { araTools } = require('../personaRuntime');
const t = araTools();
for (const tag of ['[TRANSCRIBE:', '[AUTO_CLIP:', '[RAW_EDIT:', '[BROWSE:', '[WEATHER']) assert(t.includes(tag), 'A.R.A. tools missing ' + tag);
const src = fs.readFileSync(path.join(__dirname, '..', 'personaRuntime.js'), 'utf8');
// Her own Telegram turn and a relay to her both use araTools().
assert(/\n    araTools\(\) \+/.test(src), 'systemPrompt must use araTools()');
assert(src.includes("id === 'ara' ? araTools()"), 'relaySystem must use araTools()');
// The app's prompt for her carries it too.
const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'aiService.js'), 'utf8');
assert(app.includes('[TRANSCRIBE: <link>]'), 'app buildSys lacks TRANSCRIBE');
console.log('test-ara-tools: ok');
