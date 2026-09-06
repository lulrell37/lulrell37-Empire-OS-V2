// Live status of a running Empire Council meeting. The meeting runs entirely on
// the backend (server/councilMeeting.js); while it's on, the backend keeps a
// `council_live` record updated turn by turn. CommandScreen fast-polls this
// endpoint to drive the notification banner and the gold "speaking now" glow on
// the galaxy orbs.
import{loadBackend}from './keyStore';

let last=null;

export async function fetchCouncilLive(){
  const be=await loadBackend();
  if(!be)return null;
  try{
    const res=await fetch(be.url+'/council/status',{headers:{Authorization:'Bearer '+be.token}});
    if(!res.ok)return last&&last.active?last:null;
    const j=await res.json();
    last=j;
    return j;
  }catch{
    return last&&last.active?last:null;   // a dropped poll shouldn't kill the banner mid-meeting
  }
}

// phase -> a short line for the banner when no one is mid-sentence.
export const COUNCIL_PHASE_LABEL={
  research:'pulling live market research',
  opening:'A.R.A. opening the meeting',
  discussion:'in session',
  synthesis:'A.R.A. closing it out',
  done:'meeting wrapped',
  error:'the meeting hit an error',
  stale:'lost contact with the meeting',
};
