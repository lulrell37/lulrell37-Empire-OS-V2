// Inbound lead channels for S.C.O.U.T. — finding people already looking for us.
//
//   importInboundForm()  polls a Google Sheet (a Google Form's response sheet)
//                        and turns each new row into a pipeline lead at stage
//                        "inbound". Runs on app foreground + interval, like sync.
//                        Needs Google connected and a sheet id set in
//                        Settings -> GOOGLE -> INBOUND LEADS.
//   runInboundScan()     on demand from [SCAN_INBOUND]: sweeps X and Bluesky
//                        (social), Hacker News (incl. the SEEKING FREELANCER
//                        thread), Reddit (business + big-city subs), the
//                        freelance gig boards (r/forhire, r/jobbit,
//                        r/slavelabour), Software Recommendations StackExchange,
//                        the no-code/automation community forums, and — when a
//                        metro is in context — that city's Craigslist gig/job
//                        boards, then returns a digest for S.C.O.U.T. to triage.
//
// All device-side, all while the app is open — the TradeLocker model.
import{getSetting,addLead,getFormSourceIds}from './database';
import{sheetRead,googleConnected}from './googleClient';
import{craigslistSub}from './scoutTargets';

// --- Google Form responses -> inbound leads ------------------------------

// Google Form question titles vary, so match the header row loosely on keywords.
function classifyHeader(h){
  const s=String(h||'').toLowerCase();
  if(/e-?mail/.test(s))return 'email';
  if(/phone|mobile|call|number/.test(s))return 'phone';
  if(/business|company|organi[sz]ation|\borg\b/.test(s))return 'business';
  if(/website|\bsite\b|url|domain/.test(s))return 'website';
  if(/\bname\b/.test(s))return 'name';
  if(/timestamp|^date/.test(s))return 'timestamp';
  return 'message'; // free-text "what do you need built"
}

export async function importInboundForm(){
  let sheetId='';
  try{sheetId=String((await getSetting('inbound_sheet_id',''))||'').trim();}catch{}
  if(!sheetId)return 0;
  if(!(await googleConnected().catch(()=>false)))return 0;

  let rows;
  try{rows=await sheetRead({spreadsheetId:sheetId});}catch{return 0;}
  if(!Array.isArray(rows)||rows.length<2)return 0;

  const headers=rows[0].map(classifyHeader);
  const seen=new Set((await getFormSourceIds().catch(()=>[])).map(String));
  let added=0;
  for(let r=1;r<rows.length;r++){
    const row=rows[r]||[];
    if(!row.some(c=>String(c||'').trim()))continue;
    const rec={};
    headers.forEach((key,i)=>{
      const v=String(row[i]??'').trim();
      if(!v)return;
      if(key==='message')rec.message=rec.message?`${rec.message}\n${v}`:v;
      else if(!rec[key])rec[key]=v;
    });
    const sid=`form:${(rec.timestamp||'').slice(0,32)}|${(rec.email||rec.name||'').slice(0,48)}|${r}`;
    if(seen.has(sid))continue;
    seen.add(sid);
    await addLead({
      name:rec.name||rec.business||'Website enquiry',
      business:rec.business||'',
      website:rec.website||'',
      contact:rec.email||rec.phone||'',
      bottleneck:rec.message||'',
      segment:'inbound — tarellbempire.com',
      stage:'inbound',
      source:'inbound-form',
      source_id:sid,
      log:rec.message?`Submitted the site form: ${rec.message.slice(0,400)}`:'Submitted the site form',
    });
    added++;
  }
  return added;
}

// --- Reddit + Hacker News + X sweep --------------------------------------

const DEFAULT_QUERIES=[
  'looking for someone to automate',
  'is there a tool that can',
  'need help automating my business',
  'want a custom app for my business',
  'drowning in admin work',
];
const REDDIT_SUBS='smallbusiness+Entrepreneur+sweatystartup+msp+Automate+nocode+ecommerce+shopify+PropertyManagement+nonprofit+HVAC+electricians+Plumbing+landscaping+Contractor';
// A second Reddit pass over the big city subs, where owners ask for a local
// person by trade ("can anyone recommend a web developer in Austin").
const LOCAL_SUBS='nyc+LosAngeles+chicago+houston+Atlanta+washingtondc+Seattle+austin+Denver+boston+phoenix+Dallas+Portland+Nashville+SanDiego';
const LOCAL_QUERIES=[
  '"recommend a web developer" OR "someone to build a website" OR "app developer"',
  '"looking for someone to automate" OR "build a custom" OR "software developer"',
];

function ageStr(ms){
  if(!ms)return '';
  const h=Math.floor((Date.now()-ms)/3600000);
  if(h<1)return 'just now';
  if(h<24)return h+'h';
  return Math.floor(h/24)+'d';
}
function dedupeByUrl(arr){
  const seen=new Set();
  return arr.filter(x=>{
    if(!x.url)return true;
    if(seen.has(x.url))return false;
    seen.add(x.url);return true;
  });
}

async function scanReddit(queries,signal){
  const out=[];
  for(const q of queries){
    try{
      const url=`https://www.reddit.com/r/${REDDIT_SUBS}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&limit=8&t=month`;
      const res=await fetch(url,{headers:{'User-Agent':'EmpireOS/1.0 (lead scout)'},signal});
      if(!res.ok)continue;
      const j=await res.json();
      for(const c of (j?.data?.children||[])){
        const d=c.data||{};
        out.push({
          source:'reddit',
          title:d.title||'',
          text:String(d.selftext||'').replace(/\s+/g,' ').slice(0,240),
          tag:'r/'+(d.subreddit||''),
          age:ageStr((d.created_utc||0)*1000),
          url:'https://reddit.com'+(d.permalink||''),
        });
      }
    }catch(e){if(e?.name==='AbortError')throw e;}
  }
  return dedupeByUrl(out);
}

async function scanRedditLocal(signal){
  const out=[];
  for(const q of LOCAL_QUERIES){
    try{
      const url=`https://www.reddit.com/r/${LOCAL_SUBS}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&limit=8&t=month`;
      const res=await fetch(url,{headers:{'User-Agent':'EmpireOS/1.0 (lead scout)'},signal});
      if(!res.ok)continue;
      const j=await res.json();
      for(const c of (j?.data?.children||[])){
        const d=c.data||{};
        out.push({
          source:'reddit-local',
          title:d.title||'',
          text:String(d.selftext||'').replace(/\s+/g,' ').slice(0,240),
          tag:'r/'+(d.subreddit||''),
          age:ageStr((d.created_utc||0)*1000),
          url:'https://reddit.com'+(d.permalink||''),
        });
      }
    }catch(e){if(e?.name==='AbortError')throw e;}
  }
  return dedupeByUrl(out);
}

// --- Bluesky — public AppView search, no auth --------------------------
const BSKY_QUERIES=[
  'looking for someone to build a custom tool for my business',
  'anyone know a developer who can automate this',
  'is there a tool that does this for a small business',
];
function bskyUrl(uri,handle){
  const rkey=String(uri||'').split('/').pop();
  return handle&&rkey?`https://bsky.app/profile/${handle}/post/${rkey}`:'';
}
async function scanBluesky(queries,signal){
  const qs=(queries&&queries.length)?queries:BSKY_QUERIES;
  const out=[];
  for(const q of qs.slice(0,3)){
    try{
      const url=`https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=15&sort=latest`;
      const res=await fetch(url,{signal});
      if(!res.ok)continue;
      const j=await res.json();
      for(const p of (j?.posts||[])){
        const txt=String(p?.record?.text||'').replace(/\s+/g,' ').trim();
        if(!txt)continue;
        out.push({
          source:'bluesky',
          title:txt.slice(0,150),
          text:txt.length>150?txt.slice(150,340):'',
          tag:'@'+(p?.author?.handle||'bsky'),
          age:ageStr(Date.parse(p?.indexedAt||p?.record?.createdAt||'')),
          url:bskyUrl(p?.uri,p?.author?.handle),
        });
      }
    }catch(e){if(e?.name==='AbortError')throw e;}
  }
  return dedupeByUrl(out).slice(0,14);
}

// --- No-code / automation community forums (all Discourse) -------------
// Someone stuck wiring an integration together is often a "should have hired
// this out" lead. One search per forum, best-effort.
const NOCODE_FORUMS=['forum.bubble.io','community.retool.com','community.n8n.io','community.make.com','community.zapier.com'];
const NOCODE_KEEP=/hire|freelanc|consult|contractor|need someone|someone to build|pay someone|\bbudget\b/i;
async function scanNoCodeForums(signal){
  const per=await Promise.all(NOCODE_FORUMS.map(async host=>{
    try{
      const url=`https://${host}/search.json?q=${encodeURIComponent('hire order:latest')}`;
      const res=await fetch(url,{headers:{'User-Agent':'EmpireOS/1.0 (lead scout)'},signal});
      if(!res.ok)return[];
      const j=await res.json();
      const topic={};
      for(const t of (j?.topics||[]))topic[t.id]={title:t.title||'',slug:t.slug,id:t.id,created:t.created_at};
      const rows=[];
      for(const post of (j?.posts||[]).slice(0,8)){
        const t=topic[post.topic_id];
        if(!t)continue;
        const blurb=String(post.blurb||'').replace(/\s+/g,' ').trim();
        if(!NOCODE_KEEP.test(t.title+' '+blurb))continue;
        rows.push({
          source:'forum',
          title:t.title,
          text:blurb.slice(0,240),
          tag:host.replace(/^(community|forum)\./,'').replace(/\..*$/,''),
          age:ageStr(Date.parse(t.created||post.created_at||'')),
          url:`https://${host}/t/${t.slug}/${t.id}`,
        });
      }
      return rows;
    }catch(e){if(e?.name==='AbortError')throw e;return[];}
  }));
  return dedupeByUrl(per.flat()).slice(0,10);
}

// --- Software Recommendations StackExchange ---------------------------
// "Is there a tool that does X" is a buying signal by definition. Free API,
// no key needed under the daily quota.
// Leading \b only — the tokens are prefixes ("invoic" -> invoice/invoicing).
const SRECS_KEEP=/\b(business|compan|invoic|billing|\bcrm\b|schedul|booking|appointment|inventory|payroll|\bclient|customer|\blead\b|pipeline|automat|workflow|spreadsheet|\bexcel\b|\bquote|estimat|dispatch|field.?service|e-?commerce|shopify|point of sale|\bpos\b)/i;
async function scanSoftwareRecs(signal){
  const out=[];
  try{
    const url='https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&site=softwarerecs&pagesize=40';
    const res=await fetch(url,{signal});
    if(!res.ok)return[];
    const j=await res.json();
    for(const it of (j?.items||[])){
      const title=it.title||'';
      const tags=(it.tags||[]).join(' ');
      if(!SRECS_KEEP.test(title+' '+tags))continue;
      out.push({
        source:'softwarerecs',
        title:clDecode(title),
        text:it.is_answered?'(already has an answer)':'',
        tag:'softwarerecs',
        age:ageStr((it.creation_date||0)*1000),
        url:it.link||'',
      });
    }
  }catch(e){if(e?.name==='AbortError')throw e;}
  return out.slice(0,10);
}

// --- HN "Freelancer? Seeker?" — the SEEKING FREELANCER comments -------
async function scanHnFreelance(signal){
  const out=[];
  const since=Math.floor((Date.now()-45*86400000)/1000);
  try{
    const url=`https://hn.algolia.com/api/v1/search?query=%22SEEKING%20FREELANCER%22&tags=comment&numericFilters=created_at_i%3E${since}&hitsPerPage=20`;
    const res=await fetch(url,{signal});
    if(!res.ok)return[];
    const j=await res.json();
    for(const h of (j?.hits||[])){
      const body=String(h.comment_text||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      if(!/seeking\s+freelancer/i.test(body))continue;
      out.push({
        source:'hn-freelance',
        title:body.slice(0,160),
        text:body.length>160?body.slice(160,420):'',
        tag:'HN freelance',
        age:ageStr((h.created_at_i||0)*1000),
        url:`https://news.ycombinator.com/item?id=${h.objectID}`,
      });
    }
  }catch(e){if(e?.name==='AbortError')throw e;}
  return out.slice(0,10);
}

// --- freelance / gig boards -------------------------------------------
// The Reddit "for hire" economy: r/forhire and r/jobbit run on [Hiring] /
// [For Hire] tags, r/slavelabour on [TASK] / [OFFER]. We want the buy side —
// [Hiring] and [TASK] — and only the posts that are actually about software,
// automation, scraping, a web app, a bot, a spreadsheet/no-code fix, etc.
// (these subs are full of design/writing/voiceover gigs that aren't ours).
const GIG_SUBS='forhire+jobbit+slavelabour';
const GIG_BUYING=/\[\s*(hiring|task)\s*\]/i;
const GIG_NOT=/\[\s*(for ?hire|offer|closed)\s*\]/i;
const DEVISH=/\b(develop(er|ment)?|program(mer|ming)?|python|javascript|typescript|node|react|automat(e|ion|ing)|script|web ?site|web ?app|land(ing)? ?page|scrap(e|er|ing)|crawl(er|ing)|\bapi\b|integrat(e|ion)|software|\bapp\b|\bbot\b|chat ?bot|spreadsheet|excel|google she?ets?|airtable|zapier|make\.com|dashboard|database|\bsql\b|no-?code|low-?code|saas|chrome extension|plugin|wordpress|shopify|webflow|data entry automation|workflow)\b/i;

async function scanGigBoards(signal){
  const out=[];
  try{
    const url=`https://www.reddit.com/r/${GIG_SUBS}/new.json?limit=40&raw_json=1`;
    const res=await fetch(url,{headers:{'User-Agent':'EmpireOS/1.0 (lead scout)'},signal});
    if(!res.ok)return[];
    const j=await res.json();
    for(const c of (j?.data?.children||[])){
      const d=c.data||{};
      const title=d.title||'';
      if(!GIG_BUYING.test(title)||GIG_NOT.test(title))continue;   // buy side only
      const body=String(d.selftext||'').replace(/\s+/g,' ').trim();
      if(!DEVISH.test(title+' '+body))continue;                   // our kind of work only
      out.push({
        source:'gig',
        title,
        text:body.slice(0,300),
        tag:'r/'+(d.subreddit||''),
        age:ageStr((d.created_utc||0)*1000),
        url:'https://reddit.com'+(d.permalink||''),
      });
    }
  }catch(e){if(e?.name==='AbortError')throw e;}
  return dedupeByUrl(out).slice(0,12);
}

// --- Craigslist computer gigs for the metro in context ------------------
// Per-city "computer gigs" board — local owners posting "need a site / app /
// automation built". Best-effort: Craigslist blocks some networks outright, so
// a block or any error just yields nothing rather than failing the sweep.
function clDecode(s){
  return String(s||'')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#0*39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/&#\d+;/g,' ')
    .replace(/<[^>]+>/g,' ')                          // strip tags after entity-decode
    .replace(/\s+/g,' ').trim();
}
// cpg = computer gigs, web = web/HTML/info-design gigs, sof = software jobs.
const CL_BOARDS=[['cpg','computer gig'],['web','web/design gig'],['sof','software job']];
async function scanCraigslist(metro,signal){
  const sub=craigslistSub(metro);
  if(!sub)return[];
  const out=[];
  for(const[slug,kind]of CL_BOARDS){
    try{
      const url=`https://${sub}.craigslist.org/search/${slug}?format=rss`;
      const res=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; EmpireOS lead scout)'},signal});
      if(!res.ok)continue;
      const xml=await res.text();
      for(const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)){
        const block=m[1];
        const title=clDecode((block.match(/<title>([\s\S]*?)<\/title>/)||[])[1]);
        const link=clDecode((block.match(/<link>([\s\S]*?)<\/link>/)||[])[1])
          ||(block.match(/rdf:about="([^"]+)"/)||[])[1]||'';
        const desc=clDecode((block.match(/<description>([\s\S]*?)<\/description>/)||[])[1]);
        const date=(block.match(/<dc:date>([\s\S]*?)<\/dc:date>/)||[])[1]||'';
        if(!title)continue;
        out.push({
          source:'craigslist',
          title,
          text:desc.slice(0,260),
          tag:`craigslist ${sub} · ${kind}`,
          age:date?ageStr(Date.parse(date)):'',
          url:link,
        });
      }
    }catch(e){if(e?.name==='AbortError')throw e;}
  }
  return dedupeByUrl(out).slice(0,16);
}

async function scanHackerNews(queries,signal){
  const out=[];
  const since=Math.floor((Date.now()-30*86400000)/1000);
  for(const q of queries){
    try{
      const url=`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=(story,comment,ask_hn)&numericFilters=created_at_i>${since}&hitsPerPage=6`;
      const res=await fetch(url,{signal});
      if(!res.ok)continue;
      const j=await res.json();
      for(const h of (j?.hits||[])){
        const strip=s=>String(s||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
        const title=h.title||h.story_title||strip(h.comment_text).slice(0,120);
        if(!title)continue;
        out.push({
          source:'hn',
          title,
          text:strip(h.story_text||h.comment_text).slice(0,240),
          tag:'HN',
          age:ageStr((h.created_at_i||0)*1000),
          url:h.url||`https://news.ycombinator.com/item?id=${h.objectID}`,
        });
      }
    }catch(e){if(e?.name==='AbortError')throw e;}
  }
  return dedupeByUrl(out);
}

// Two angles on X per sweep instead of one generic call — gives it real
// coverage alongside Reddit/HN's multi-query loops rather than a single
// afterthought search.
const X_QUERIES=[
  'small business owners on X this week saying "looking for someone to build" a custom tool or automation',
  'X posts this week asking "does anyone know a developer who can automate" for a small business',
];
async function scanX(personaId,customQuery,signal){
  const{webSearch}=await import('./aiService');
  const queries=customQuery?[`${customQuery} — recent posts on X / Twitter, people asking for this`]:X_QUERIES;
  const blocks=[];
  for(const q of queries){
    try{
      const r=await webSearch(personaId,q,signal);
      if(r&&String(r).trim())blocks.push(String(r).trim().slice(0,1200));
    }catch(e){if(e?.name==='AbortError')throw e;}
  }
  return blocks;
}

// Returns a text digest for the [SCAN_INBOUND] tool injection in CommandScreen.
// Every channel here surfaces someone who may already want what Empire Digital
// builds; S.C.O.U.T. triages the digest and [LEAD_ADD]s the genuine ones into
// the pipeline. When the caller passes a metro in `opts`, the local Craigslist
// boards are swept too.
export async function runInboundScan(personaId,extraQuery,signal,opts={}){
  const custom=String(extraQuery||'').trim();
  const queries=custom?[custom]:DEFAULT_QUERIES;
  const metro=String(opts?.metro||'').trim();
  const parts=[];

  const[hn,xBlocks,reddit,redditLocal,gigs,craigslist,bluesky,forums,srecs,hnFree]=await Promise.all([
    scanHackerNews(queries.slice(0,4),signal).catch(()=>[]),
    scanX(personaId,custom,signal).catch(()=>[]),
    scanReddit(queries.slice(0,4),signal).catch(()=>[]),
    scanRedditLocal(signal).catch(()=>[]),
    scanGigBoards(signal).catch(()=>[]),
    metro?scanCraigslist(metro,signal).catch(()=>[]):Promise.resolve([]),
    scanBluesky(custom?[custom]:null,signal).catch(()=>[]),
    scanNoCodeForums(signal).catch(()=>[]),
    scanSoftwareRecs(signal).catch(()=>[]),
    scanHnFreelance(signal).catch(()=>[]),
  ]);

  const fmt=(list,n=6)=>list.slice(0,n).map(p=>`  [${p.tag}${p.age?` · ${p.age}`:''}] ${p.title}${p.text?`\n    ${p.text}`:''}\n    ${p.url}`).join('\n');

  parts.push(hn.length
    ?'HACKER NEWS — recent posts matching the search:\n'+fmt(hn,8)
    :'HACKER NEWS — nothing matched in the last month.');
  parts.push(xBlocks.length
    ?'X / TWITTER — people posting about this right now:\n'+xBlocks.join('\n\n')
    :'X / TWITTER — nothing matched.');
  parts.push(bluesky.length
    ?'BLUESKY — people posting this right now:\n'+fmt(bluesky,8)
    :'BLUESKY — nothing matched.');
  parts.push(gigs.length
    ?'GIG BOARDS (Reddit r/forhire · r/jobbit · r/slavelabour) — open [Hiring]/[Task] posts for our kind of work:\n'+fmt(gigs,8)
    :'GIG BOARDS — no open software/automation gigs right now.');
  if(metro)parts.push(craigslist.length
    ?`CRAIGSLIST ${metro} — local computer / web gigs and software jobs:\n`+fmt(craigslist,10)
    :`CRAIGSLIST ${metro} — nothing on the local boards (or they were unreachable).`);
  if(srecs.length)parts.push('SOFTWARE RECOMMENDATIONS (StackExchange) — "is there a tool that…" from owners:\n'+fmt(srecs,8));
  if(hnFree.length)parts.push('HN · SEEKING FREELANCER — outfits hiring a build out this cycle:\n'+fmt(hnFree,8));
  if(forums.length)parts.push('NO-CODE / AUTOMATION FORUMS (Bubble · Retool · n8n · Make · Zapier) — people stuck who may want to hire it out:\n'+fmt(forums,8));
  const redditAll=[...reddit,...redditLocal];
  if(redditAll.length)parts.push('REDDIT (business + city subs) — recent posts matching the search:\n'+fmt(redditAll,12));

  return parts.filter(Boolean).join('\n\n---\n\n');
}
