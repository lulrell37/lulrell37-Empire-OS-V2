// Inbound lead channels for S.C.O.U.T. — finding people already looking for us.
//
//   importInboundForm()  polls a Google Sheet (a Google Form's response sheet)
//                        and turns each new row into a pipeline lead at stage
//                        "inbound". Runs on app foreground + interval, like sync.
//                        Needs Google connected and a sheet id set in
//                        Settings -> GOOGLE -> INBOUND LEADS.
//   runInboundScan()     on demand from [SCAN_INBOUND]: sweeps Reddit, Hacker
//                        News and (via the persona's own web search) X for
//                        owners publicly asking for what Empire Digital builds,
//                        and returns a digest for S.C.O.U.T. to triage.
//
// All device-side, all while the app is open — the TradeLocker model.
import{getSetting,addLead,getFormSourceIds}from './database';
import{sheetRead,googleConnected}from './googleClient';

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
const REDDIT_SUBS='smallbusiness+Entrepreneur+sweatystartup+msp+Automate+nocode';

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
// X and Hacker News are the priority channels — people there tend to post the
// exact "does anyone know a tool that..." buying signal in public, searchable
// form. Reddit still runs (it's free, direct-API, sometimes turns up real
// signal too) but reads after the two priority channels in the digest.
export async function runInboundScan(personaId,extraQuery,signal){
  const custom=String(extraQuery||'').trim();
  const queries=custom?[custom]:DEFAULT_QUERIES;
  const parts=[];

  const[hn,xBlocks,reddit]=await Promise.all([
    scanHackerNews(queries.slice(0,4),signal).catch(()=>[]),
    scanX(personaId,custom,signal).catch(()=>[]),
    scanReddit(queries.slice(0,4),signal).catch(()=>[]),
  ]);

  parts.push(hn.length
    ?'HACKER NEWS — recent posts matching the search:\n'+hn.slice(0,12).map(p=>`  [${p.tag} · ${p.age}] ${p.title}${p.text?`\n    ${p.text}`:''}\n    ${p.url}`).join('\n')
    :'HACKER NEWS — nothing matched in the last month.');
  parts.push(xBlocks.length
    ?'X / TWITTER — people posting about this right now:\n'+xBlocks.join('\n\n')
    :'X / TWITTER — nothing matched.');
  if(reddit.length)parts.push('REDDIT — recent posts matching the search:\n'+reddit.slice(0,12).map(p=>`  [${p.tag} · ${p.age}] ${p.title}${p.text?`\n    ${p.text}`:''}\n    ${p.url}`).join('\n'));

  return parts.join('\n\n---\n\n');
}
