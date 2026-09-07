// One place every failure goes. Routes an error to:
//   1. the crash log (Settings → DIAGNOSTICS)
//   2. the top banner (NudgeBar firmIssues) — keyed so the same source can't
//      stack, severity by kind, and a TTL so transient failures fade on their
//      own instead of piling up.
// Call this instead of a bare `catch {}` or an Alert wherever a real failure
// happens that Mr. Burrus would want to know about — an AI call, an integration,
// a background job.
import useEmpireStore from '../store/useEmpireStore';
import{logCrash}from './crashLog';

const short=(s,n=160)=>{const t=String(s||'').replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n-1)+'…':t;};

// Network / timeout / 5xx → transient (amber, fades in 6 min). Auth / config /
// bad-request / data → hard (red, fades in 30 min, or stays if severity forced).
function classify(err){
  const m=String(err&&(err.message||err)||'').toLowerCase();
  const status=err&&(err.status||err.code);
  if(status===401||status===403||/unauthor|forbidden|invalid api key|api key|no token|not connected|credential/.test(m))return{severity:'error',ttl:0};
  if(status===429||/rate limit|quota|too many/.test(m))return{severity:'error',ttl:30*60000};
  if(status===400||/invalid|bad request|malformed|schema|required/.test(m))return{severity:'error',ttl:30*60000};
  if(/network|timeout|timed out|fetch failed|econn|socket|offline|unreachable|503|502|500|temporarily/.test(m))return{severity:'warn',ttl:6*60000};
  return{severity:'warn',ttl:15*60000};
}

// key: stable id for this failure source, e.g. 'ai:rogue', 'google:calendar',
// 'tradelocker', 'sync'. label: short human phrase, e.g. "R.O.G.U.E. couldn't reply".
export function reportIssue(key,label,err,opts={}){
  try{
    const c=classify(err);
    const sev=opts.severity||c.severity;
    const ttl=opts.ttlMs!=null?opts.ttlMs:c.ttl;
    const msg=err&&(err.message||String(err));
    const text=msg?`${label} — ${short(msg,90)}`:label;
    const detail=[label,msg&&`\n${msg}`,opts.detail&&`\n\n${opts.detail}`].filter(Boolean).join('');
    useEmpireStore.getState().flagFirmIssue(key,text,detail||null,sev,ttl);
    logCrash('reported:'+key,`${label}${msg?` — ${msg}`:''}`,err&&err.stack);
  }catch{}
}

// The matching op succeeded — clear its banner entry.
export function clearIssueKey(key){
  try{useEmpireStore.getState().clearFirmIssue(key);}catch{}
}
