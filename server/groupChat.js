// The Empire group chat on Telegram. He makes a group, adds the persona bots and
// sends anything in it; A.R.A.'s bot (Group Privacy off in BotFather, so it sees
// every message) saves it as THE group and answers there. Bots can't see each
// other's messages, so the server does the talking between them:
//   - every persona-to-persona hand-off ([RELAY_TO], from his private chats or the
//     group) is posted here as it happens: the ask from the asking persona's bot,
//     the answer from the other's
//   - personas with their own bot post as themselves; the rest post through
//     A.R.A.'s bot with their name on the line
//   - in the group, A.R.A. answers whatever names nobody and brings in anyone she
//     wants; a named persona or "everyone"/"council" goes to them, one at a time,
//     each hearing the ones before (runInjections, sink.group)
// State: app_settings.tg_group ({ chatId, title }). No group set = nothing posted.
const { getSetting, setSetting } = require('./syncStore');
const { ROSTER } = require('./personas');

const KEY = 'tg_group';
let cached;

async function group() {
  if (cached !== undefined) return cached;
  try { const raw = await getSetting(KEY, ''); cached = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { cached = null; }
  return cached;
}
async function setGroup(chat) {
  const g = { chatId: String(chat.id), title: chat.title || 'Empire group', at: Date.now() };
  const cur = await group();
  if (cur && cur.chatId === g.chatId) return false;
  cached = g;
  await setSetting(KEY, JSON.stringify(g)).catch((e) => console.error('group chat save failed:', e.message));
  return true;
}
const isGroupChat = (chat) => !!chat && (chat.type === 'group' || chat.type === 'supergroup');

// ---- Voice: every line in the group also goes out as a voice note --------------
// In the persona's OWN voice (ROSTER[id].voiceId), from the same bot that posts the
// text. Never A.R.A.'s voice or her Grok script pass for someone else's words: a
// non-A.R.A. line goes straight to ElevenLabs with speakNames applied (A.R.A.'s own
// lines use her normal script pass, as everywhere else).
// Every persona with a voiceId on its ROSTER entry speaks in it (kept equal to the app's
// elevenlabsVoiceId by test-group-chat.js). Only scribe, hook, sage, wire and woke have none,
// so they use the ONE generic default below.
// GROUP_DEFAULT_VOICE overrides it; the fallback is ElevenLabs' stock "Adam".
const DEFAULT_VOICE_ID = 'pNInz6obpgDQGcFmaJgB';
const VOICE_MAX_CHARS = 600;
const voiceFor = (personaId) => (ROSTER[personaId] && ROSTER[personaId].voiceId) || process.env.GROUP_DEFAULT_VOICE || DEFAULT_VOICE_ID;

// A line over ~600 characters is voiced as its first sentences plus the sentences
// with numbers (no AI call); the full text stays as the message.
function voiceText(text) {
  const body = String(text || '').replace(/[*#`_]+/g, '').replace(/\s+/g, ' ').trim();
  if (body.length <= VOICE_MAX_CHARS) return body;
  const sentences = body.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [body];
  let out = '';
  let i = 0;
  for (; i < sentences.length && out.length + sentences[i].length <= 360; i++) out += sentences[i];
  if (!out) out = body.slice(0, 360);
  for (const s of sentences.slice(i)) {
    if (!/\d/.test(s) || out.length + s.length > VOICE_MAX_CHARS - 40) continue;
    out += s;
  }
  return `${out.trim()} The rest is in the message.`;
}

async function elevenOut() {
  try { return (await require('./sentinel').status()).some((x) => x.key === 'elevenlabs' && /out of characters/.test(x.msg || '')); } catch { return false; }
}

// Never throws. Voice notes go out in order after the text, off the caller's path.
let voiceChain = Promise.resolve();
async function voice(personaId, text, sender, chatId) {
  if (/^(off|0|false)$/i.test(process.env.GROUP_VOICE || '')) return false;
  try {
    const say = voiceText(text);
    if (!say) return false;
    const { voiceNote } = require('./personaVoice');
    const own = ROSTER[personaId] && ROSTER[personaId].voiceId;
    const r = await voiceNote(personaId, say, { scripted: personaId !== 'ara', voiceId: own ? undefined : voiceFor(personaId), noEleven: await elevenOut() });
    if (!r || !r.ogg) throw new Error(r && r.error ? r.error : 'no audio');
    await sender.sendVoice(chatId, r.ogg);
    return true;
  } catch (e) {
    console.error('group chat failed: voice', e.message);
    return false;
  }
}
const queueVoice = (...a) => { voiceChain = voiceChain.then(() => voice(...a)).catch(() => {}); };
const voiceIdle = () => voiceChain;

// One line in the group from `personaId`: its own bot when it has one (and that
// bot is in the group), else A.R.A.'s with the name on the line.
async function post(personaId, text) {
  const g = await group();
  const t = String(text || '').trim();
  if (!g || !t) return false;
  const telegram = require('./telegram');
  const name = (ROSTER[personaId] && ROSTER[personaId].name) || personaId;
  const own = telegram.botFor(personaId);
  const body = t.length > 3800 ? `${t.slice(0, 3800)}…` : t;
  if (own && own.isConfigured()) {
    try { await own.sendMessage(g.chatId, body, { log: false }); queueVoice(personaId, t, own, g.chatId); return true; } catch (e) {
      if (personaId === 'ara') { console.error('group chat post failed:', e.message); return false; }
    }
  }
  const ara = telegram.botFor('ara');
  if (!ara || !ara.isConfigured()) return false;
  try { await ara.sendMessage(g.chatId, `${name}:\n${body}`, { log: false }); queueVoice(personaId, t, ara, g.chatId); return true; } catch (e) { console.error('group chat post failed:', e.message); return false; }
}

// A hand-off, shown in the group: the ask, then the answer.
async function relayAsked(from, to, message) {
  const toName = (ROSTER[to] && ROSTER[to].name) || to;
  return post(from, `→ ${toName}: ${message}`).catch(() => false);
}
// The exchange also goes into the answering persona's own Telegram history, so
// in his private chat with them later they remember what they said in the group.
// (The asking persona's turn already keeps the answer it got.)
function groupLine(from, to, message, answer, ts = Date.now()) {
  const when = new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const fromName = (ROSTER[from] && ROSTER[from].name) || from;
  return `[IN THE EMPIRE GROUP CHAT, ${when} ET — ${fromName} asked you this in front of Mr. Burrus, not in this chat]\n${fromName}: ${String(message).slice(0, 3000)}\nYou answered: ${String(answer).slice(0, 5000)}`;
}
async function remember(from, to, message, answer) {
  if (!(await group())) return;
  await require('./db').query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', [to, 'assistant', groupLine(from, to, message, answer), Date.now()])
    .catch((e) => console.error('group chat history save failed:', e.message));
}
// A hand-off that passes on his own words to the persona he named ("Mr. Burrus asks
// you: …"): that answer is to him. Any other hand-off is teammate to teammate.
const HIS_WORDS = /^\s*\[?\s*(mr\.? burrus|he|tarell)\s+(asks|asked|says|said|wants to know|is asking|wrote)\b/i;
const hisWords = (message) => HIS_WORDS.test(String(message || ''));
async function relayAnswered(to, answer, { from, message } = {}) {
  if (from && message) await remember(from, to, message, answer);
  // Their words and receipts, without the note meant only for the asking persona.
  const shown = String(answer || '').replace(/\n*\([^()]*ran no actions[^]*$/, '').trim();
  // Labeled like the ask ("→ A.R.A.: …"), so the group reads as them talking to each
  // other, not to him (owner, 2026-11-26).
  const fromName = from && ROSTER[from] && !hisWords(message) ? ROSTER[from].name : '';
  return post(to, fromName && shown ? `→ ${fromName}: ${shown}` : shown).catch(() => false);
}

// What his message in the group needs A.R.A. to do.
const GROUP_FRAME = `[THE EMPIRE GROUP CHAT — he wrote this in the Telegram group with the team, not in your private chat. Everyone sees the hand-offs here: each [RELAY_TO] you make, and their answer, is posted in the group from that persona's own bot (or yours with their name). So:
 - He names someone ("Selene, what do you think") → [RELAY_TO: selene | Mr. Burrus asks you: <his full message>] (start it exactly "Mr. Burrus asks you:" so they answer him, not you); your own reply is one short line at most, or nothing more than what adds to theirs.
 - He says everyone / the council / the team / all of you → [RELAY_TO: id | Mr. Burrus asks you: <his message>] for each persona who has something real to add (any of them; you pick), one tag each. They answer one at a time and each sees the ones before, so they build on each other. Then give the bottom line in a few sentences.
 - He names no one → answer it yourself, and bring in whoever should weigh in.
Don't repeat what they said; they've already said it in the group.]`;

module.exports = { hisWords, groupLine, group, setGroup, isGroupChat, post, voice, voiceText, voiceFor, voiceIdle, DEFAULT_VOICE_ID, relayAsked, relayAnswered, GROUP_FRAME };
