// A compact cross-domain read of the Empire — revenue, trading, outreach,
// builds — injected into A.R.A.'s and N.O.V.A.'s context (see aiService.buildSys)
// so they always know how every front is doing without waiting for a relay.
import{getBusinessesWithRevenue,getAllLeads,getInboundLeads,getLeadsDue,getOpenTrades,getActiveBuildJobs,getSetting,getTodayStr}from './database';

const money=n=>`$${Math.round(Number(n)||0).toLocaleString()}`;

export async function empireStatusBlock(personaId){
  const L=[];

  try{
    const biz=await getBusinessesWithRevenue();
    const total=biz.reduce((a,b)=>a+(b.rev||0),0);
    const targetTotal=biz.reduce((a,b)=>a+(b.target||0),0);
    const active=biz.filter(b=>b.rev>0).sort((a,b)=>b.rev-a.rev);
    L.push(`REVENUE this month: ${money(total)}${targetTotal?` of ${money(targetTotal)} target`:''}`
      +(active.length?` — ${active.slice(0,6).map(b=>`${b.name} ${money(b.rev)}`).join(', ')}`:' — nothing logged yet'));
    // The full roster from the HUD Business panel (add/delete there flows straight
    // through here), so A.R.A. always knows exactly which businesses exist —
    // not just the ones with revenue logged this month.
    if(biz.length)L.push(`BUSINESSES (${biz.length}) — ${biz.map(b=>b.target>0?`${b.name} (target ${money(b.target)}/mo)`:b.name).join(', ')}`);
  }catch{}

  try{
    const open=await getOpenTrades('talon');
    const auto=(await getSetting('auto_trade','0'))==='1';
    const uP=open.reduce((a,t)=>a+(Number(t.last_unrealized)||0),0);
    const bits=[`${open.length} open${open.length?` (${open.map(t=>t.symbol).join(', ')}), unrealized ${uP>=0?'+':''}${uP.toFixed(2)}`:''}`];
    try{
      const{tradeRecord}=await import('./tradeJournal');
      const rec=await tradeRecord({});
      if(rec&&rec.count)bits.push(`record ${rec.wins}W-${rec.losses}L${rec.winRate!=null?` ${rec.winRate}%`:''}, net ${rec.net>=0?'+':''}${rec.net}${rec.streak>=2?`, on a ${rec.streak}${rec.streakType==='win'?'W':'L'} streak`:''}`);
    }catch{}
    bits.push(auto?'auto-trade ON (demo)':'manual only');
    L.push(`TRADING (T.A.L.O.N.): ${bits.join(' · ')}`);
  }catch{}

  try{
    const leads=await getAllLeads();
    const tally={};leads.forEach(l=>{tally[l.stage]=(tally[l.stage]||0)+1;});
    const inbound=(await getInboundLeads()).length;
    const due=(await getLeadsDue(getTodayStr())).length;
    const auto=(await getSetting('auto_scout','0'))==='1';
    let today='';
    try{const s=JSON.parse((await getSetting('auto_scout_stats',''))||'{}');if(s.date===getTodayStr())today=` · today +${s.added||0} leads, ${s.sent||0} emails sent`;}catch{}
    const stageStr=Object.entries(tally).map(([k,v])=>`${v} ${k}`).join(', ')||'empty';
    L.push(`OUTREACH (S.C.O.U.T.): ${leads.length} lead${leads.length===1?'':'s'} (${stageStr})`
      +`${inbound?` · ${inbound} inbound waiting`:''}${due?` · ${due} follow-up${due===1?'':'s'} due`:''} · ${auto?'auto-scout ON':'manual only'}${today}`);
  }catch{}

  try{
    const jobs=await getActiveBuildJobs();
    if(jobs.length)L.push(`BUILDS: ${jobs.length} active — ${jobs.map(j=>`#${j.issue_number} ${j.state}${j.project_name?` (${j.project_name})`:''}`).join(', ')}`);
  }catch{}

  // Outcome of the last nightly Empire Council (runs server-side at 5am ET — the
  // personas meet on their own, pull live market research, and set next steps).
  // The full transcript is one [READ_NOTE: Empire Council] away.
  try{
    const raw=await getSetting('council_last','');
    if(raw){
      const c=JSON.parse(raw);
      if(c&&c.headline){
        const lines=[`LATEST COUNCIL (${c.date}) — ${c.headline}`];
        (c.perItem||[]).slice(0,8).forEach(it=>{
          if(it&&it.name)lines.push(` · ${it.name}: ${(it.steps&&it.steps[0])||'see the note'}`);
        });
        lines.push('Full transcript + reasoning: [READ_NOTE: Empire Council]');
        L.push(lines.join('\n'));
      }
    }
  }catch{}

  const ideaLine=personaId==='ara'
    ?"\nWhen Mr. Burrus gives you a strategy idea for the nightly council to work through, emit [COUNCIL_IDEA: the idea] to put it on the agenda."
    :'';
  if(!L.length&&!ideaLine)return '';
  return `\n\n[EMPIRE STATUS — a live read of every front, refreshed each turn. Reference it naturally when it's relevant, and raise anything that needs Mr. Burrus's attention rather than waiting to be asked:\n${L.join('\n')}${ideaLine}\n]`;
}
