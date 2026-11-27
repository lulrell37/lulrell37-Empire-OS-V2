// The call-mode player (android/…/CallAudioModule.kt). null where it isn't built in
// (iOS, an older APK): callers fall back to expo-av.
import{Platform}from 'react-native';
let mod=null;
if(Platform.OS==='android'){
  try{mod=require('expo-modules-core').requireNativeModule('CallAudio');}catch{mod=null;}
}
export default mod;
