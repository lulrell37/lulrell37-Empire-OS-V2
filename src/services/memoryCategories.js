// On-device memory categorization — no API. Every stored memory is dropped into
// one category bucket by keyword match, and a handful of salient keywords are
// pulled out for later relevance matching. Nothing here rewrites or condenses
// the memory text — the full exchange is always kept verbatim elsewhere.

export const CATEGORIES=[
  {key:'business',label:'Business',color:'#D4A017',words:['business','empire','revenue','client','deal','sale','sales','launch','brand','branding','wholesale','wholesaling','import','export','clothing','php','networking','youtube','shorts','affiliate','lawn','junk','removal','noir','zodiac','velvet','society','resurrection','llc','invoice','customer','pricing','profit','margin','scale','startup','offer','vendor','supplier','contract value','b2b']},
  {key:'trading',label:'Trading',color:'#4A9E7A',words:['trade','trading','trader','xauusd','gold','forex','pip','pips','entry','exit','stop loss','take profit','chart','setup','gbpchf','nzdcad','eurjpy','eurusd','gbpusd','usdjpy','usdcad','audusd','gbpjpy','tradelocker','position','candle','candlestick','market','bullish','bearish','liquidity','drawdown','risk management']},
  {key:'health',label:'Health',color:'#F0F0F0',words:['workout','gym','train','training','deadlift','bench','squat','pull-up','pushup','run','running','cardio','diet','nutrition','sleep','batman protocol','martial arts','boxing','conditioning','mobility','injury','recovery','body','bodyweight','weight','calories','protein','doctor','wellness','fasting','stretch']},
  {key:'spiritual',label:'Faith',color:'#C89B3C',words:['god','jesus','christ','lord','bible','scripture','verse','psalm','proverbs','gospel','prayer','pray','praying','faith','covenant','church','pastor','holy','spirit','worship','sin','repent','blessing','blessed','kingdom','righteous','disciple','testimony','grace']},
  {key:'learning',label:'Learning',color:'#5B8DEF',words:['learn','learning','study','studying','teach','lesson','course','curriculum','university','topic','understand','explain','concept','knowledge','book','reading','history','science','math','mathematics','physics','philosophy','psychology','language','vocabulary','definition','theory']},
  {key:'legal',label:'Legal',color:'#7B2FBE',words:['contract','legal','law','lawsuit','liability','ip','intellectual property','trademark','copyright','patent','employment','lease','agreement','clause','incorporation','compliance','terms','nda','llc formation','operating agreement','dispute','attorney','statute']},
  {key:'content',label:'Content',color:'#FF69B4',words:['content','video','post','posting','script','hook','caption','thumbnail','viral','virality','audience','engagement','reel','reels','story','tiktok','instagram','youtube shorts','followers','subscriber','creative','copywriting','copy','narrative','storytelling','editing','b-roll']},
  {key:'mindset',label:'Mindset',color:'#E0555F',words:['discipline','disciplined','focus','mindset','fear','doubt','doubts','motivation','motivated','habit','habits','procrastinate','procrastinating','procrastination','excuse','excuses','confidence','mental','pressure','resilience','consistency','accountability','identity','standards','grind','weakness','weak','lazy','laziness','comfort','comfortable','willpower']},
  {key:'planning',label:'Planning',color:'#FFB300',words:['task','tasks','todo','to-do','remind','reminder','schedule','scheduling','deadline','appointment','calendar','meeting','follow-up','due','plan','planning','priority','priorities','milestone','roadmap']},
  {key:'personal',label:'Personal',color:'#8A8A8A',words:['family','relationship','friend','friends','girlfriend','wife','kids','son','daughter','home','house','personal','feeling','feelings','tired','stressed','happy','birthday','vacation','visit','visiting','mom','dad','brother','sister','parents']},
];

const STOP=new Set(['the','a','an','and','or','but','if','then','this','that','these','those','with','for','from','into','your','you','him','his','her','she','they','them','their','our','was','were','are','been','being','have','has','had','not','can','could','would','should','will','just','about','what','when','where','which','who','how','all','any','some','one','two','get','got','out','off','over','under','more','most','than','also','very','much','many','into','onto','upon','mr','burrus','sir','yes','okay',' text','said','say','says','tell','told','know','think','want','need','make','made','like','good','great','right','now','here','there','back','way','time','day','today','let','going','gonna','stuff','thing','things']);

function tokens(text){
  return String(text||'').toLowerCase().replace(/[^a-z0-9\s'-]/g,' ').split(/\s+/).filter(Boolean);
}

const esc=(w)=>w.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&');
// Precompile one word-boundary regex per category (single words) + keep the
// multi-word phrases for substring checks.
const COMPILED=CATEGORIES.map(cat=>{
  const singles=cat.words.filter(w=>!w.includes(' '));
  const phrases=cat.words.filter(w=>w.includes(' '));
  return{key:cat.key,phrases,re:singles.length?new RegExp('\\b('+singles.map(esc).join('|')+')\\b','g'):null};
});

// Count how many category words appear in the text (multi-word phrases counted too).
function scoreCategory(lowerText,compiled){
  let n=0;
  if(compiled.re){const m=lowerText.match(compiled.re);if(m)n+=m.length;}
  for(const p of compiled.phrases)if(lowerText.includes(p))n+=2;
  return n;
}

export function classifyMemory(text){
  const lower=String(text||'').toLowerCase();
  const scored=[];
  for(const c of COMPILED){
    const sc=scoreCategory(lower,c);
    if(sc>0)scored.push({key:c.key,score:sc});
  }
  scored.sort((a,b)=>b.score-a.score);
  // `categories` = every bucket the text touches (a message can span two, e.g.
  // "how's trading affecting the business"); `category` stays the single best
  // one for storage/tagging and back-compat.
  return{
    category:scored.length?scored[0].key:'personal',
    categories:scored.map(x=>x.key),
    keywords:extractKeywords(text),
  };
}

export function extractKeywords(text,max=8){
  const toks=tokens(text);
  const freq={};
  const catWords=new Set();
  CATEGORIES.forEach(c=>c.words.forEach(w=>{if(!w.includes(' '))catWords.add(w);}));
  for(const t of toks){
    if(t.length<4||STOP.has(t))continue;
    freq[t]=(freq[t]||0)+(catWords.has(t)?3:1);
  }
  // proper nouns from the original casing
  for(const m of String(text||'').match(/\b[A-Z][a-zA-Z]{3,}\b/g)||[]){
    const t=m.toLowerCase();
    if(!STOP.has(t))freq[t]=(freq[t]||0)+2;
  }
  return Object.keys(freq).sort((a,b)=>freq[b]-freq[a]).slice(0,max);
}

export function categoryMeta(key){return CATEGORIES.find(c=>c.key===key)||CATEGORIES[CATEGORIES.length-1];}

// Relevance of a stored memory to the current query. Higher = more relevant.
export function memoryRelevance(mem,queryCategory,queryKeywords){
  let score=0;
  if(mem.category&&mem.category===queryCategory)score+=3;
  const kw=(()=>{try{return JSON.parse(mem.keywords||'[]');}catch{return[];}})();
  const qset=new Set(queryKeywords);
  for(const k of kw)if(qset.has(k))score+=2;
  return score;
}
