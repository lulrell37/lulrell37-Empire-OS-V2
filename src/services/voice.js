// One-shot speech for contexts outside the main Command chat (the diagram card,
// proactive nudges, …). ElevenLabs when a key + voiceId are available, native
// TTS otherwise. Item 2 builds the streaming voice-synced pipeline; this is the
// simple fire-and-forget path.
import{Audio}from 'expo-av';
import*as Speech from 'expo-speech';
import{textToSpeech}from './aiService';
import{loadKeys}from './keyStore';

let current=null;

export async function stopSpeaking(){
  try{
    if(current){await current.stopAsync();await current.unloadAsync();}
  }catch{}
  current=null;
  try{Speech.stop();}catch{}
}

export async function speak(text,voiceId,personaName){
  await stopSpeaking();
  const clean=String(text||'').replace(/\[[^\]]*\]/g,'').replace(/[*#`_]/g,'').trim();
  if(!clean)return;
  let uri=null;
  try{
    const k=await loadKeys();
    if(voiceId&&k?.elevenlabs)uri=await textToSpeech(clean,voiceId,personaName);
  }catch{}
  if(uri){
    try{
      await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});
      const{sound}=await Audio.Sound.createAsync({uri},{shouldPlay:true});
      current=sound;
      sound.setOnPlaybackStatusUpdate(s=>{if(s.didJustFinish){current=null;}});
      return;
    }catch{}
  }
  try{Speech.speak(clean.slice(0,600),{language:'en-US',rate:0.96});}catch{}
}
