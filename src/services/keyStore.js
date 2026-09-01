import*as SecureStore from 'expo-secure-store';
const KEY='empire_os_keys';
const GOOGLE_KEY='empire_os_google_token';
const TRADE_KEY='empire_os_tradelocker';
export async function saveKeys(keys){await SecureStore.setItemAsync(KEY,JSON.stringify(keys));}
export async function loadKeys(){try{const v=await SecureStore.getItemAsync(KEY);return v?JSON.parse(v):null;}catch{return null;}}
export async function clearKeys(){await SecureStore.deleteItemAsync(KEY);}
// tok: { accessToken, refreshToken, expiresAt, scope }
export async function saveGoogleToken(tok){
  const obj=typeof tok==='string'?{accessToken:tok}:{...tok};
  await SecureStore.setItemAsync(GOOGLE_KEY,JSON.stringify({...obj,savedAt:Date.now()}));
}
export async function loadGoogleToken(){try{const v=await SecureStore.getItemAsync(GOOGLE_KEY);return v?JSON.parse(v):null;}catch{return null;}}
export async function clearGoogleToken(){await SecureStore.deleteItemAsync(GOOGLE_KEY);}
// TradeLocker login: { email, password, server, env: 'demo'|'live' }
export async function saveTradeCreds(creds){await SecureStore.setItemAsync(TRADE_KEY,JSON.stringify(creds));}
export async function loadTradeCreds(){try{const v=await SecureStore.getItemAsync(TRADE_KEY);return v?JSON.parse(v):null;}catch{return null;}}
export async function clearTradeCreds(){await SecureStore.deleteItemAsync(TRADE_KEY);}

// GitHub fine-grained PAT for the JARVIS build pipeline (Contents/Issues/PRs: RW
// on the Empire OS repo). Stored as a bare token string.
const GITHUB_KEY='empire_os_github';
export async function saveGitHubToken(token){await SecureStore.setItemAsync(GITHUB_KEY,String(token||''));}
export async function loadGitHubToken(){try{return(await SecureStore.getItemAsync(GITHUB_KEY))||null;}catch{return null;}}
export async function clearGitHubToken(){await SecureStore.deleteItemAsync(GITHUB_KEY);}

// Backend: { url, token }. When set, the app syncs to it and routes AI calls
// through it. When absent, the app is fully local (unchanged behaviour).
const BACKEND_KEY='empire_os_backend';
export async function saveBackend({url,token}){
  const clean={url:String(url||'').trim().replace(/\/+$/,''),token:String(token||'').trim()};
  await SecureStore.setItemAsync(BACKEND_KEY,JSON.stringify(clean));
  return clean;
}
export async function loadBackend(){try{const v=await SecureStore.getItemAsync(BACKEND_KEY);const b=v?JSON.parse(v):null;return b?.url&&b?.token?b:null;}catch{return null;}}
export async function clearBackend(){await SecureStore.deleteItemAsync(BACKEND_KEY);}
