import*as Google from 'expo-auth-session/providers/google';
import{exchangeCodeAsync,refreshAsync,revokeAsync}from 'expo-auth-session';
import*as WebBrowser from 'expo-web-browser';
import{loadGoogleToken,saveGoogleToken}from './keyStore';
WebBrowser.maybeCompleteAuthSession();

const ANDROID_CLIENT_ID='766739048614-4af9ehee2qnrfj6suf1khehfoun7628v.apps.googleusercontent.com';
const WEB_CLIENT_ID='766739048614-bhhpmp86ca15o5h2s07j61bfarj2ha21.apps.googleusercontent.com';

// Native (Android/iOS) OAuth clients have no client secret — the auth-code
// exchange and refresh are done with PKCE alone.
const NATIVE_CLIENT_ID=ANDROID_CLIENT_ID;

const DISCOVERY={
  authorizationEndpoint:'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint:'https://oauth2.googleapis.com/token',
  revocationEndpoint:'https://oauth2.googleapis.com/revoke',
};

const SCOPES=[
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
];

export function useGoogleAuth(){
  // Auth-code flow (not implicit) so Google returns a refresh token.
  // access_type=offline + prompt=consent are what make the refresh token come
  // back — Google only issues one when consent is explicitly re-granted.
  // The Google provider derives the (working) native redirect URI itself; do
  // not override it. shouldAutoExchangeCode:false — we exchange manually below
  // so we control token storage and expiry tracking.
  return Google.useAuthRequest({
    androidClientId:ANDROID_CLIENT_ID,
    webClientId:WEB_CLIENT_ID,
    scopes:SCOPES,
    responseType:'code',
    shouldAutoExchangeCode:false,
    extraParams:{access_type:'offline',prompt:'consent select_account',login_hint:'tarellburrus@gmail.com'},
  });
}

function shape(res,fallbackRefresh){
  const expiresIn=Number(res.expiresIn)||3600;
  return{
    accessToken:res.accessToken,
    refreshToken:res.refreshToken||fallbackRefresh||null,
    expiresAt:Date.now()+expiresIn*1000,
    scope:res.scope||SCOPES.join(' '),
  };
}

// Trade the one-time authorization code for { accessToken, refreshToken, expiresAt }.
export async function exchangeGoogleCode(code,request){
  const res=await exchangeCodeAsync({
    clientId:NATIVE_CLIENT_ID,
    code,
    redirectUri:request.redirectUri,
    extraParams:request?.codeVerifier?{code_verifier:request.codeVerifier}:{},
  },DISCOVERY);
  return shape(res);
}

async function refreshGoogleToken(refreshToken){
  const res=await refreshAsync({clientId:NATIVE_CLIENT_ID,refreshToken},DISCOVERY);
  return shape(res,refreshToken);
}

// Best-effort revoke at Google so no live refresh token is left behind on
// disconnect. Never throws.
export async function revokeGoogle(){
  try{
    const tok=await loadGoogleToken();
    const t=tok?.refreshToken||tok?.accessToken;
    if(t)await revokeAsync({token:t,clientId:NATIVE_CLIENT_ID},DISCOVERY);
  }catch{}
}

let refreshInFlight=null;

// The single accessor every Google API call should use. Returns a valid access
// token, silently refreshing it when it's within 60s of expiry. Returns null if
// the account isn't connected; returns the stored token unchanged for a legacy
// implicit-flow token that has no refresh token (user must reconnect once).
export async function getFreshGoogleToken(){
  const tok=await loadGoogleToken();
  if(!tok?.accessToken)return null;
  if(tok.expiresAt&&Date.now()<tok.expiresAt-60000)return tok.accessToken;
  if(!tok.refreshToken)return tok.accessToken;
  if(!refreshInFlight){
    refreshInFlight=(async()=>{
      try{
        const next=await refreshGoogleToken(tok.refreshToken);
        await saveGoogleToken(next);
        return next.accessToken;
      }finally{refreshInFlight=null;}
    })();
  }
  return refreshInFlight;
}
