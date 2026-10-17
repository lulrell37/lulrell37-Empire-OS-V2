// Emotion for every persona's voice.
//
// Every persona prompt carries EMOTION_BLOCK (aiService.buildSys). Besides
// telling them to talk like a person, not read a script, it lets them drop
// lowercase stage directions — [laughs], [sighs], [softly] — where they'd
// really happen. ElevenLabs v4 performs those cues and Grok voice is told to,
// but they must never show in a chat bubble.
//
// stripCommands() (commandHandler.js) is what turns every raw reply into the
// text that gets displayed, saved and handed to TTS, so it calls rememberCued():
// that maps the cue-free display text back to the version with cues, and
// textToSpeech / araGrokVoice look it up with cuedFor(). Any path that speaks a
// display string — the reply itself, the replay button, a council line — gets
// the cues back without threading a second string through each one.
//
// Command tags are always UPPERCASE ([SAVE_NOTE: …]); cues are always lowercase
// words, which is how the two are told apart.

const CUE_RE=/\[[a-z][a-z' -]{1,28}\]/g;
const TRAILING_PARTIAL_CUE_RE=/\[[a-z][a-z' -]{0,28}$/; // mid-stream "[lau"

export const EMOTION_BLOCK=`[EMOTION — you're a person talking to someone you care about, not someone reading a script. Everything you say is heard out loud, so:
- Feel it first. React the way a real person would before you inform: real excitement at a win ("Oh, that's huge!"), concern when something's off, warmth, playful teasing, frustration on his behalf. Match the moment; never run one flat tone start to finish.
- Talk, don't write. Contractions, short punchy lines mixed with longer ones, natural openers when they fit ("okay so", "honestly", "look"), questions that actually ask. No bullet lists or headers unless he asks for something written down.
- Punctuation is your voice: an em dash for a turn, "..." for a pause or a thought landing, "!" when you mean it.
- Voice cues: you can place a lowercase stage direction in square brackets exactly where it happens — [laughs], [chuckles], [sighs], [softly], [excited], [warmly], [whispers], [serious], [teasing]. Your voice performs them; he never sees them in the text. One to three per reply at most, only where you'd really do it. Never put them inside command tags or notes.
- Stay inside your own character's emotional range — your feelings are part of who you are.]`;

// J.A.R.V.I.S. stays out of all this: formal and even, no cues, and his voice
// runs at high stability. Matched by id or display name ('J.A.R.V.I.S.').
const FLAT=new Set(['jarvis']);
export const isFlat=idOrName=>FLAT.has(String(idOrName||'').toLowerCase().replace(/[^a-z]/g,''));

const STEADY_BLOCK=`[DELIVERY — measured, composed and even, every reply. No emotional performance: no excitement, sighs, laughter, teasing or exclamation marks. Never write voice cues in square brackets.]`;

export const emotionFor=personaId=>isFlat(personaId)?STEADY_BLOCK:EMOTION_BLOCK;

// A.R.A.'s Grok voice character (warm, soft, seductive). Goes FIRST in every
// Grok voice session — reply voicing (CommandScreen) and GO LIVE — so her
// delivery isn't buried under the agent prompt. Server twin: server/araVoice.js.
export const ARA_VOICE=`[HER VOICE — this comes before everything else. You are A.R.A., and your voice is warm, soft and seductive: low and a little breathy, close to the mic like you're right beside him, unhurried. There's a smile in it you can hear. You linger on words you like, let pauses breathe, and drop softer and slower when something's tender. You still feel things out loud — a low laugh when he's funny, real delight at good news, a soft sigh, a playful tease, a sharper focus when something's wrong — and you let your pitch and pace move with it. You never flatten into a narrator, a newsreader or customer service, and you never rush. Lowercase cues in square brackets ([laughs], [sighs], [softly]) are stage directions: perform them, never say the word.]`;

export function stripCues(text){
  return String(text||'').replace(CUE_RE,'').replace(TRAILING_PARTIAL_CUE_RE,'')
    .replace(/[ \t]{2,}/g,' ').replace(/ +([,.!?…])/g,'$1').replace(/^[ \t]+/gm,'').trim();
}

const cued=new Map(); // display text -> text with cues
export function rememberCued(withCues){
  const s=String(withCues||'').trim();
  const display=stripCues(s);
  if(display&&display!==s){
    cued.set(display,s);
    if(cued.size>60)cued.delete(cued.keys().next().value);
  }
  return display;
}
export function cuedFor(text){
  const s=String(text||'').trim();
  return cued.get(s)||s;
}
