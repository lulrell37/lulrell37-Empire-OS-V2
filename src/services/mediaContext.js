// Turns links a persona is handed — YouTube, TikTok, Instagram, X, Facebook,
// Reddit, or any web page — into something the persona can actually reason over:
// title, author, description, a transcript when there is one, and the poster
// image. React Native's fetch is not bound by CORS, so this all runs on-device;
// every step is best-effort and a failure degrades to a short note rather than
// breaking the turn.
import*as FileSystem from 'expo-file-system';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const HDRS={'User-Agent':UA,'Accept-Language':'en-US,en;q=0.9'};
const URL_RE=/https?:\/\/[^\s<>()"']+/gi;

export function extractUrls(text){
  const raw=String(text||'').match(URL_RE)||[];
  const out=[];
  for(let u of raw){
    u=u.replace(/[.,;:!?)\]]+$/,'');           // trailing punctuation
    if(!out.includes(u))out.push(u);
  }
  return out.slice(0,4);
}

export function hasUrl(text){return /https?:\/\/[^\s]+/i.test(String(text||''));}

function decodeEntities(s){
  return String(s||'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16)))
    .replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(parseInt(d,10)));
}
function stripTags(s){return decodeEntities(String(s||'').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();}
function meta(html,prop){
  const re=new RegExp('<meta[^>]+(?:property|name)=["\']'+prop.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'["\'][^>]*>','i');
  const tag=html.match(re)?.[0];
  if(!tag)return'';
  return decodeEntities(tag.match(/content=["']([^"']*)["']/i)?.[1]||'').trim();
}
async function getText(url,signal){
  const res=await fetch(url,{headers:HDRS,signal});
  if(!res.ok)throw new Error('HTTP '+res.status);
  return await res.text();
}
async function getJson(url,signal){
  const res=await fetch(url,{headers:{...HDRS,Accept:'application/json'},signal});
  if(!res.ok)throw new Error('HTTP '+res.status);
  return await res.json();
}

// --- YouTube --------------------------------------------------------------
function youTubeId(url){
  const m=url.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m?m[1]:null;
}
async function youTubeTranscript(id,signal){
  // The watch page carries ytInitialPlayerResponse with the caption tracks.
  const html=await getText(`https://www.youtube.com/watch?v=${id}&hl=en`,signal);
  const tracks=html.match(/"captionTracks":(\[.*?\}\s*\])/s)?.[1];
  if(!tracks)return'';
  let list;try{list=JSON.parse(tracks.replace(/\\u0026/g,'&'));}catch{return'';}
  const track=list.find(t=>/^en/i.test(t.languageCode))||list[0];
  if(!track?.baseUrl)return'';
  const xml=await getText(track.baseUrl.replace(/\\u0026/g,'&'),signal);
  const lines=[...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m=>stripTags(m[1]));
  return lines.join(' ').replace(/\s+/g,' ').trim();
}
async function fetchYouTube(url,signal){
  const id=youTubeId(url);
  const out={kind:'youtube',url,title:'',author:'',description:'',transcript:'',thumbnailUrl:''};
  try{
    const o=await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,signal);
    out.title=o.title||'';out.author=o.author_name||'';out.thumbnailUrl=o.thumbnail_url||'';
  }catch{}
  if(id&&!out.thumbnailUrl)out.thumbnailUrl=`https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  try{
    const html=await getText(`https://www.youtube.com/watch?v=${id}&hl=en`,signal);
    out.description=out.description||meta(html,'og:description');
    out.title=out.title||meta(html,'og:title');
  }catch{}
  if(id){try{out.transcript=await youTubeTranscript(id,signal);}catch{}}
  return out;
}

// --- Other platforms via oEmbed / OpenGraph -----------------------------
async function fetchOEmbed(endpoint,url,signal){
  const o=await getJson(`${endpoint}?url=${encodeURIComponent(url)}`,signal);
  return{
    title:o.title||o.author_name||'',
    author:o.author_name||'',
    description:stripTags(o.html||'')||o.title||'',
    thumbnailUrl:o.thumbnail_url||'',
  };
}
async function fetchReddit(url,signal){
  const j=await getJson(url.replace(/\/?$/,'')+'.json',signal);
  const post=j?.[0]?.data?.children?.[0]?.data||{};
  return{
    kind:'reddit',url,
    title:post.title||'',
    author:post.author?('u/'+post.author):'',
    description:(post.selftext||'').slice(0,4000),
    transcript:'',
    thumbnailUrl:(post.preview?.images?.[0]?.source?.url||'').replace(/&amp;/g,'&'),
  };
}
async function fetchGeneric(url,signal){
  const host=(url.match(/^https?:\/\/([^/]+)/)?.[1]||'').replace(/^www\./,'');
  let kind='link';
  if(/tiktok\.com/.test(host))kind='tiktok';
  else if(/instagram\.com/.test(host))kind='instagram';
  else if(/(twitter\.com|x\.com)/.test(host))kind='x';
  else if(/facebook\.com|fb\.watch/.test(host))kind='facebook';

  // Platform oEmbeds that don't need a token.
  try{
    if(kind==='tiktok'){const e=await fetchOEmbed('https://www.tiktok.com/oembed',url,signal);return{kind,url,transcript:'',...e};}
    if(kind==='x'){const e=await fetchOEmbed('https://publish.twitter.com/oembed',url,signal);return{kind,url,transcript:'',...e};}
  }catch{}

  const html=await getText(url,signal);
  return{
    kind,url,
    title:meta(html,'og:title')||stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||''),
    author:meta(html,'og:site_name')||meta(html,'author'),
    description:meta(html,'og:description')||meta(html,'description'),
    transcript:'',
    thumbnailUrl:meta(html,'og:image')||meta(html,'twitter:image'),
  };
}

async function downloadThumb(thumbUrl,signal){
  if(!thumbUrl||!/^https?:\/\//.test(thumbUrl))return null;
  try{
    const ext=(thumbUrl.match(/\.(jpe?g|png|webp)(?:\?|$)/i)?.[1]||'jpg').toLowerCase();
    const dest=FileSystem.cacheDirectory+'lnk_'+Date.now()+'_'+Math.random().toString(36).slice(2,7)+'.'+ext;
    const r=await FileSystem.downloadAsync(thumbUrl,dest,{headers:HDRS});
    return r?.status===200?{uri:r.uri,mime:ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg'}:null;
  }catch{return null;}
}

// Returns { url, kind, title, author, description, transcript, thumb:{uri,mime}|null }
export async function fetchLinkContext(url,{signal}={}){
  let ctx;
  try{
    if(/youtube\.com|youtu\.be/.test(url))ctx=await fetchYouTube(url,signal);
    else if(/reddit\.com/.test(url))ctx=await fetchReddit(url,signal);
    else ctx=await fetchGeneric(url,signal);
  }catch(e){
    return{url,kind:'link',error:e.message||String(e)};
  }
  ctx.thumb=await downloadThumb(ctx.thumbnailUrl,signal);
  return ctx;
}

// Fold a fetched context into the text block a persona reads + its poster image.
export function linkContextToBlock(ctx){
  if(ctx.error)return{text:`[LINKED MEDIA — ${ctx.url} (couldn't be read: ${ctx.error})]`,image:null};
  const L=[`[LINKED MEDIA — ${ctx.url}`];
  if(ctx.title)L.push(`Title: ${ctx.title}`);
  if(ctx.author)L.push(`By: ${ctx.author}`);
  if(ctx.description)L.push(`Description: ${String(ctx.description).slice(0,1200)}`);
  if(ctx.transcript)L.push(`Transcript / captions:\n${String(ctx.transcript).slice(0,9000)}`);
  if(!ctx.transcript&&(ctx.kind==='youtube'||ctx.kind==='tiktok'||ctx.kind==='instagram'||ctx.kind==='facebook'))
    L.push('(No transcript was available — reason from the title, description and the poster frame.)');
  L.push(']');
  return{text:L.join('\n'),image:ctx.thumb||null};
}
