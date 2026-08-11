import*as SecureStore from 'expo-secure-store';
const KEY='empire_os_keys';
const GOOGLE_KEY='empire_os_google_token';
export async function saveKeys(keys){await SecureStore.setItemAsync(KEY,JSON.stringify(keys));}
export async function loadKeys(){try{const v=await SecureStore.getItemAsync(KEY);return v?JSON.parse(v):null;}catch{return null;}}
export async function clearKeys(){await SecureStore.deleteItemAsync(KEY);}
export async function saveGoogleToken(accessToken){await SecureStore.setItemAsync(GOOGLE_KEY,JSON.stringify({accessToken,savedAt:Date.now()}));}
export async function loadGoogleToken(){try{const v=await SecureStore.getItemAsync(GOOGLE_KEY);return v?JSON.parse(v):null;}catch{return null;}}
export async function clearGoogleToken(){await SecureStore.deleteItemAsync(GOOGLE_KEY);}
