// AI-influencer content pipeline — batch compile + publish.
//
// compileBatch()   F.O.R.G.E. takes the page personas' `queued` items. With a
//                  Higgsfield key set it sends each item's prompt + that page's
//                  reference photos to Higgsfield — image/carousel to Soul, reel
//                  to DoP image->video — and moves them to `awaiting_media`;
//                  contentJobs.js drops the finished media into the queue on its
//                  own. With no key it returns the shot sheet to run by hand.
// publishContent() H.E.R.A.L.D. posts `approved` items to their page's
//                  Instagram / Facebook. Real publishing runs on the backend
//                  (needs the Meta app + per-page tokens) — until that's set up
//                  this reports what it would post without sending anything.
import{getContentItems,getContentItem,updateContentItem,getContentTally,getContentPages}from './database';
import{higgsfieldKey,submitImage,submitVideo,POST_SIZE}from './higgsfield';

// Reference photo URLs stored on a page (videos are kept but not sent — the
// generation models take images).
function pagePhotoRefs(cfg){
  const refs=Array.isArray(cfg?.refs)?cfg.refs:[];
  return refs.filter(r=>r&&r.url&&r.type!=='video').map(r=>r.url);
}

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

  const key=await higgsfieldKey();

  // No Higgsfield key — hand back the manual shot sheet.
  if(!key){
    const lines=[`BATCH COMPILED — ${items.length} item${items.length===1?'':'s'}${page?` for ${page}`:''}, moved to "awaiting_media".`,
      'No Higgsfield key set (Settings → KEYS) — run each prompt in Higgsfield yourself, then attach the result in the Content screen:',''];
    let n=1;
    for(const it of items){
      await updateContentItem(it.id,{status:'awaiting_media'}).catch(()=>{});
      lines.push(`${n}. [${it.page} · ${it.kind} · ${it.slot||'—'}]  id ${short(it.id)}`);
      lines.push(`   ${String(it.prompt||'(no prompt)').replace(/\s+/g,' ')}`);
      n++;
    }
    return lines.join('\n');
  }

  // Send each item's prompt + its page's reference photos to Higgsfield.
  // image / carousel -> Soul text2image (one photo as image_reference);
  // reel -> DoP image->video (the photos as input_images).
  const pages=await getContentPages().catch(()=>({}));
  let ok=0;const fails=[];const noRef=new Set();
  for(const it of items){
    try{
      const cfg=pages[it.page]||{};
      const photos=pagePhotoRefs(cfg);
      if(!photos.length)noRef.add(it.page);
      let jobId;
      if(it.kind==='reel'){
        jobId=await submitVideo(it.prompt,photos,{key});
      }else{
        jobId=await submitImage(it.prompt,{
          size:POST_SIZE,
          batch:it.kind==='carousel'?4:1,
          referenceUrl:photos[0]||undefined,
          key,
        });
      }
      if(!jobId)throw new Error('no job id returned');
      await updateContentItem(it.id,{status:'awaiting_media',gen_job_id:jobId,gen_phase:'',error:''});
      ok++;
    }catch(e){
      fails.push(`${short(it.id)} — ${e.message}`);
      await updateContentItem(it.id,{status:'failed',error:'generation submit failed — '+e.message}).catch(()=>{});
    }
  }
  return `BATCH SUBMITTED to Higgsfield — ${ok}/${items.length} generating${page?` for ${page}`:''}.`
    +` They drop into the queue as they finish.`
    +(noRef.size?`\nNo reference photos for ${[...noRef].join(', ')} — add them in Studio → Pages so she's recognisable.`:'')
    +(fails.length?`\nFailed to submit: ${fails.join('; ')}`:'');
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
