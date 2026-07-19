import*as SecureStore from 'expo-secure-store';
const KEY='empire_os_keys';
export async function saveKeys(keys){await SecureStore.setItemAsync(KEY,JSON.stringify(keys));}
export async function loadKeys(){try{const v=await SecureStore.getItemAsync(KEY);return v?JSON.parse(v):null;}catch{return null;}}
export async function clearKeys(){await SecureStore.deleteItemAsync(KEY);}
