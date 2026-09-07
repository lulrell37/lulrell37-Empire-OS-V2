// A rough "time remaining" for the GitHub-Actions queue jobs — R.O.G.U.E.'s clip
// edits and the video watches. Those agents don't report progress: they flip a
// single status marker (editing / watching) and then, some minutes later, post a
// result. So this is an estimate, not a real countdown — the running median of
// how long recent jobs of the same kind actually took, with a plain default
// until there's enough history to beat it. Returns '' / null when there's
// nothing worth showing (job already finished, no timestamps).
//
// History rows come straight from getClipJobs() / getWatchJobs(); a job records
// `started_at` when its poller first sees the editing/watching marker, so a
// completed job's real run time is updated_at - started_at.

const DEFAULTS={
  // priors in ms, used only until MIN_SAMPLES real jobs have completed
  clip:{queue:3*60*1000,run:8*60*1000},
  watch:{queue:3*60*1000,run:12*60*1000},
};
const MIN_SAMPLES=3;
const RECENT=8;

function median(xs){
  if(!xs.length)return null;
  const s=[...xs].sort((a,b)=>a-b);
  const m=s.length>>1;
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}

// typical run duration (status-flip -> result) from recent completed jobs
function typicalRun(kind,history){
  const d=DEFAULTS[kind]||DEFAULTS.clip;
  const runs=(history||[])
    .filter(j=>j.status==='done'&&j.started_at&&j.updated_at&&j.updated_at>j.started_at)
    .slice(0,RECENT)
    .map(j=>j.updated_at-j.started_at);
  return runs.length>=MIN_SAMPLES?median(runs):d.run;
}

// { remaining: ms (can be negative), run: the typical run length used } or null
export function jobEta(kind,job,history){
  if(!job||!job.created_at)return null;
  if(!['queued','editing','watching'].includes(job.status))return null;
  const d=DEFAULTS[kind]||DEFAULTS.clip;
  const run=typicalRun(kind,history);
  const now=Date.now();
  const remaining=job.status==='queued'
    ? (d.queue+run)-(now-job.created_at)
    : run-(now-(job.started_at||job.created_at));
  return{remaining,run};
}

// Short line for a job row / banner chip: "~6 min left", "almost done",
// "running long", or '' when there's nothing to say. There's a grace band once
// the estimate elapses (the priors are rough until a few real jobs have
// completed) so it doesn't snap straight to "running long".
export function etaText(kind,job,history){
  const e=jobEta(kind,job,history);
  if(!e)return'';
  const m=Math.round(e.remaining/60000);
  if(m>=1)return`~${m} min left`;
  if(e.remaining>-Math.max(90000,e.run*0.5))return'almost done';
  return'running long';
}

// A 0..1 fill for a progress bar, plus the same short caption. Time-based — the
// agents don't report real progress, so this tracks elapsed-vs-expected and is
// held below 100% until the job genuinely finishes (a done/failed job returns
// null and the row swaps to its result). Once the estimate is blown the last
// sliver creeps in asymptotically so the bar keeps inching without ever claiming
// it's done. `quantize` rounds the fraction to visible steps for the banner,
// where anything finer just churns re-renders.
export function jobProgress(kind,job,history,quantize=0){
  const e=jobEta(kind,job,history);
  if(!e)return null;
  // If the agent ever reports a real percent (clip-progress / watch-progress
  // marker -> job.progress), trust that over the time estimate.
  if(job&&job.progress>0&&job.progress<100){
    let frac=job.progress/100;
    if(quantize>0)frac=Math.round(frac/quantize)*quantize;
    return{frac,caption:etaText(kind,job,history)};
  }
  const d=DEFAULTS[kind]||DEFAULTS.clip;
  const total=e.run+(job.status==='queued'?d.queue:0);
  let frac;
  if(e.remaining>0){
    frac=Math.min(0.92,Math.max(0.03,(total-e.remaining)/total));
  }else{
    const over=-e.remaining;
    frac=0.92+0.07*(1-1/(1+over/(e.run*0.5)));   // 0.92 -> ~0.99
  }
  if(quantize>0)frac=Math.round(frac/quantize)*quantize;
  return{frac,caption:etaText(kind,job,history)};
}
