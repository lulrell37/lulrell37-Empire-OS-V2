import*as Google from 'expo-auth-session/providers/google';
import*as WebBrowser from 'expo-web-browser';
WebBrowser.maybeCompleteAuthSession();

const ANDROID_CLIENT_ID='766739048614-4af9ehee2qnrfj6suf1khehfoun7628v.apps.googleusercontent.com';
const WEB_CLIENT_ID='766739048614-bhhpmp86ca15o5h2s07j61bfarj2ha21.apps.googleusercontent.com';
const SCOPES=[
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
];

export function useGoogleAuth(){
  // Let the Google provider derive the native redirect URI itself
  // (`com.lulrell37.empireos:/oauthredirect`). Do not override it with a
  // reversed-client-ID scheme — that is the iOS convention and Google rejects
  // it against an Android client ID with "Error 400: invalid_request".
  return Google.useAuthRequest({
    androidClientId:ANDROID_CLIENT_ID,
    webClientId:WEB_CLIENT_ID,
    scopes:SCOPES,
    // Always show the Google account picker instead of silently reusing the
    // device's default signed-in account. `selectAccount` is the provider's
    // canonical option and also sets `prompt=select_account` explicitly.
    selectAccount:true,
    extraParams:{prompt:'select_account'},
  });
}
