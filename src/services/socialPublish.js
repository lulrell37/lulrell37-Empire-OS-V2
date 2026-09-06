// AI-influencer content pipeline — batch compile + publish.
//
// compileBatch()   F.O.R.G.E. turns the page personas' `queued` items into a
//                  shot sheet and moves them to `awaiting_media`. When the
//                  Higgsfield API is wired it will submit them directly; until
//                  then Mr. Burrus runs the sheet in Higgsfield and attaches
//                  each result in the Content screen.
// publishContent() H.E.R.A.L.D. posts `approved` items to their page's
//                  Instagram / Facebook. Real publishing runs on the backend
//                  (needs the Meta app + per-page tokens) — until that's set up
//                  this reports what it would post without sending anything.
import{getContentItems,getContentItem,updateContentItem,getContentTally,getContentPages}from './database';

const short=id=>String(id||'').slice(0,8);

export async function contentStatusLine(){
  const rows=await getContentTally().catch(()=>[]);
  if(!rows.length)return 'nothing in the pipeline yet.';
  const byPage={};
  for(const r of rows){(byPage[r.page]||(byPage[r.page]=[])).push(`${r.n} ${r.status}`);}
  return Object.entries(byPage).map(([p,parts])=>`${p}: ${parts.join(', ')}`).join(' · ');
}

export async function compileBatch(page){
  const items=await getContentItems({page:page||undefined,status:'queued'});
  if(!items.length)return `BATCH: nothing queued${page?` for ${page}`:''} to compile.`;
  const lines=[`BATCH COMPILED — ${items.length} item${items.length===1?'':'s'}${page?` for ${page}`:''}, moved to "awaiting_media".`,
    'Run each prompt in Higgsfield, then attach the result to its item id in the Content screen:',''];
  let n=1;
  for(const it of items){
    await updateContentItem(it.id,{status:'awaiting_media'}).catch(()=>{});
    lines.push(`${n}. [${it.page} · ${it.kind} · ${it.slot||'—'}]  id ${short(it.id)}`);
    lines.push(`   ${String(it.prompt||'(no prompt)').replace(/\s+/g,' ')}`);
    n++;
  }
  return lines.join('\n');
}

export async function publishContent(target){
  const pages=await getContentPages().catch(()=>({}));
  let items=[];
  if(target&&target.id){
    const raw=String(target.id).trim();
    let it=await getContentItem(raw).catch(()=>null);
    if(!it){
      const all=await getContentItems({});
      it=all.find(x=>x.id.startsWith(raw))||null;
    }
    if(!it)return `PUBLISH: no item matches "${raw}".`;
    if(it.status!=='approved')return `PUBLISH: item ${short(it.id)} is "${it.status}", not approved — Mr. Burrus approves it in the Content screen first.`;
    items=[it];
  }else{
    items=await getContentItems({page:target?.page||undefined,status:'approved'});
    if(!items.length)return `PUBLISH: nothing approved${target?.page?` for ${target.page}`:''} and waiting.`;
  }

  const out=[];
  for(const it of items){
    const cfg=pages[it.page];
    if(!cfg||!cfg.ig_user_id||!cfg.access_token){
      out.push(`• ${it.page} #${short(it.id)} — NOT SENT: ${it.page} has no Instagram account/token set up yet (Settings → Content).`);
      continue;
    }
    // Real publish is a backend job (media has to be hosted at a public URL for
    // Meta to fetch). Not wired yet — report the intent, leave it approved.
    out.push(`• ${it.page} → @${cfg.handle||'?'} #${short(it.id)} — would post now (${it.kind}). Publishing goes live once the Meta app is approved and the backend worker is wired.`);
  }
  return 'PUBLISH:\n'+out.join('\n');
}
