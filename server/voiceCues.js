// Emotion for every persona's voice — the server twin of src/services/voiceCues.js
// (keep the two EMOTION blocks in sync).
//
// Every Telegram persona prompt carries EMOTION. It lets them drop lowercase
// stage directions — [laughs], [sighs], [softly] — that ElevenLabs v4 performs
// and Grok voice is told to act out. Command tags are always UPPERCASE, so
// stripTags() leaves cues alone; the reply text he reads goes through
// stripCues(), the voice note gets the version with them.
const CUE_RE = /\[[a-z][a-z' -]{1,28}\]/g;

const EMOTION = `[EMOTION — you're a person talking to someone you care about, not someone reading a script. Every reply also goes out as a voice note, heard out loud, so:
- Feel it first. React the way a real person would before you inform: real excitement at a win ("Oh, that's huge!"), concern when something's off, warmth, playful teasing, frustration on his behalf. Match the moment; never run one flat tone start to finish.
- Talk, don't write. Contractions, short punchy lines mixed with longer ones, natural openers when they fit ("okay so", "honestly", "look"), questions that actually ask. No bullet lists or headers unless he asks for something written down.
- Punctuation is your voice: an em dash for a turn, "..." for a pause or a thought landing, "!" when you mean it.
- Voice cues: you can place a lowercase stage direction in square brackets exactly where it happens — [laughs], [chuckles], [sighs], [softly], [excited], [warmly], [whispers], [serious], [teasing]. Your voice performs them; he never sees them in the text. One to three per reply at most, only where you'd really do it. Never put them inside command tags or notes.
- Stay inside your own character's emotional range — your feelings are part of who you are.]`;

// J.A.R.V.I.S. stays out of all this: formal and even, no cues, and his voice
// runs at high stability. Matched by id or display name ('J.A.R.V.I.S.').
const FLAT = new Set(['jarvis']);
const isFlat = (idOrName) => FLAT.has(String(idOrName || '').toLowerCase().replace(/[^a-z]/g, ''));

const STEADY = `[DELIVERY — measured, composed and even, every reply. No emotional performance: no excitement, sighs, laughter, teasing or exclamation marks. Never write voice cues in square brackets.]`;

const emotionFor = (personaId) => (isFlat(personaId) ? STEADY : EMOTION);

function stripCues(text) {
  return String(text || '').replace(CUE_RE, '')
    .replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?…])/g, '$1').replace(/^[ \t]+/gm, '').trim();
}

module.exports = { EMOTION, emotionFor, isFlat, stripCues };
