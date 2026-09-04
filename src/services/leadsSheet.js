// Mirrors the leads pipeline into a Google Sheet so it's readable outside the
// app — a laptop, a shared tab, whatever. One-way: the app owns the data, the
// sheet is overwritten on every push. Editing the sheet doesn't feed back in.
import{getSetting,setSetting,getAllLeads}from './database';
import{sheetCreateRaw,sheetReplace,googleConnected}from './googleClient';

const HEADERS=['ID','Name','Business','Stage','Contact','Bottleneck','Value','Segment','Next action','Next touch','Last touch','Website','Source','Added','Latest activity'];

function rowFor(l){
  return[
    String(l.id),l.name||'',l.business||'',l.stage||'',l.contact||'',l.bottleneck||'',
    l.value||'',l.segment||'',l.next_action||'',l.next_touch||'',l.last_touch||'',
    l.website||'',l.source||'',l.created_at?new Date(l.created_at).toISOString().slice(0,10):'',
    (l.log||'').split('\n')[0]||'',
  ];
}

export function leadsSheetUrl(id){return id?`https://docs.google.com/spreadsheets/d/${id}/edit`:null;}

// One-tap setup: makes the sheet, remembers its id, does the first push.
export async function createLeadsSheet(){
  if(!(await googleConnected().catch(()=>false)))throw new Error('Connect Google first — Settings → GOOGLE.');
  const{id,url}=await sheetCreateRaw('S.C.O.U.T. — Lead Pipeline');
  await setSetting('leads_sheet_id',id);
  await pushLeadsToSheet();
  return{id,url};
}
export async function unlinkLeadsSheet(){await setSetting('leads_sheet_id','');}
export async function getLeadsSheetId(){return(await getSetting('leads_sheet_id',''))||'';}

// Coalesces overlapping calls — several leads changing at once triggers one
// trailing push instead of a pile of redundant writes.
let pushing=false,dirty=false;
export async function pushLeadsToSheet(){
  const id=await getLeadsSheetId();
  if(!id)return;
  if(!(await googleConnected().catch(()=>false)))return;
  if(pushing){dirty=true;return;}
  pushing=true;
  try{
    const leads=await getAllLeads();
    await sheetReplace(id,[HEADERS,...leads.map(rowFor)]);
  }catch{/* best-effort mirror — never block the caller */}
  finally{
    pushing=false;
    if(dirty){dirty=false;pushLeadsToSheet();}
  }
}
