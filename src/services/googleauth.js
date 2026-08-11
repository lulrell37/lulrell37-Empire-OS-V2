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
  return Google.useAuthRequest({
    androidClientId:ANDROID_CLIENT_ID,
    webClientId:WEB_CLIENT_ID,
    scopes:SCOPES,
  });
}
