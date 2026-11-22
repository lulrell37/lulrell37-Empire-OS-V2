// [REDEPLOY] from the app: the same restart as on Telegram (server/redeploy.js),
// behind a confirm dialog here instead of a Confirm card. POST /redeploy.
import{Alert}from 'react-native';
import{loadBackend}from './keyStore';
import{notify}from './report';

export function confirmRedeploy(){
  Alert.alert(
    'Redeploy the server?',
    'Restarts the backend onto the latest main (about 1-2 minutes). Telegram bots, T.A.L.O.N. and the crons pause and come back on the newest code. If it fails to start, it falls back to the current version. A.R.A. confirms on Telegram when it\'s live.',
    [{text:'Cancel',style:'cancel'},{text:'Redeploy',style:'destructive',onPress:runRedeploy}],
  );
}

async function runRedeploy(){
  const be=await loadBackend();
  if(!be){Alert.alert('No server linked','Connect the backend in Settings › BACKEND first.');return;}
  try{
    const res=await fetch(be.url+'/redeploy',{method:'POST',headers:{Authorization:'Bearer '+be.token,'Content-Type':'application/json'},body:'{}'});
    const j=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(j.error||`server ${res.status}`);
    notify(j.text||'Redeploying: A.R.A. will confirm on Telegram when it\'s live.',{severity:'info',ttlMs:120000});
  }catch(e){
    Alert.alert('Redeploy failed',String(e.message||e));
  }
}
