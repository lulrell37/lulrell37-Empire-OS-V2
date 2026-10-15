// How fast the personas talk — one setting (app_settings `voice_speed`, synced,
// so the Telegram voice notes follow it too) applied to every playback path:
// ElevenLabs / Grok audio plays at this rate with pitch correction (faster, not
// chipmunk), and the native-TTS fallback scales its rate the same way.
import{Audio}from 'expo-av';
import{getSetting,setSetting}from './database';

export const VOICE_SPEED_MIN=0.75;
export const VOICE_SPEED_MAX=2;
const clamp=(r)=>Math.min(VOICE_SPEED_MAX,Math.max(VOICE_SPEED_MIN,Math.round((Number(r)||1)*20)/20));

let rate=1;
const listeners=new Set();

export const voiceRate=()=>rate;

export async function loadVoiceSpeed(){
  try{rate=clamp(parseFloat(await getSetting('voice_speed','1')));}catch{rate=1;}
  return rate;
}

export async function setVoiceSpeed(r){
  rate=clamp(r);
  listeners.forEach(fn=>{try{fn(rate);}catch{}});
  await setSetting('voice_speed',String(rate));
  return rate;
}

// Applied live to whatever's playing right now, when the slider moves.
export function onVoiceSpeedChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}

// Initial status for Audio.Sound.createAsync.
export function playOpts(extra={}){
  return{...extra,rate,shouldCorrectPitch:true,pitchCorrectionQuality:Audio.PitchCorrectionQuality.High};
}

// expo-speech rate for the native fallback voice (its own 1.0 is normal speed).
export const speechRate=(base=0.95)=>Math.min(2,base*rate);

// Re-rate a sound that's already playing.
export function applyRate(sound){
  if(!sound)return;
  sound.setRateAsync(rate,true,Audio.PitchCorrectionQuality.High).catch(()=>{});
}
