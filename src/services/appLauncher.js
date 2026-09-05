// Opens another app on the phone — the actual app, never a webpage fallback,
// per Mr. Burrus's instruction. Ara can open a webpage instead when he
// explicitly asks for one (that's a plain https:// link, not this).
//
// Android launches the app directly by its verified Play Store package name,
// via an Android "intent:" URI Linking.openURL understands natively — no
// custom URL scheme needed (those vary app to app and are inconsistently
// documented; a wrong one silently breaks the launch). If the package isn't
// resolvable, openURL rejects and we report "not installed" — there is no
// URL fallback to degrade to, by design.
//
// This depends on every package below being declared in a <queries> block in
// AndroidManifest.xml (see plugins/withAppQueries.js) — Android 11+ hides
// package-visibility by default, so without it EVERY app here reports as
// "not installed" regardless of the truth. That's baked in at build time, so
// this feature needs a fresh EAS build before it works — it won't take effect
// as an OTA update. Keep this list in sync with plugins/withAppQueries.js.
import{Linking,Platform}from 'react-native';

const ANDROID_PACKAGES={
  spotify:'com.spotify.music',
  instagram:'com.instagram.android',
  tiktok:'com.zhiliaoapp.musically',
  youtube:'com.google.android.youtube',
  twitter:'com.twitter.android',x:'com.twitter.android',
  facebook:'com.facebook.katana',
  whatsapp:'com.whatsapp',
  uber:'com.ubercab',
  ubereats:'com.ubercab.eats','uber eats':'com.ubercab.eats',
  maps:'com.google.android.apps.maps','google maps':'com.google.android.apps.maps',
  waze:'com.waze',
  gmail:'com.google.android.gm',
  amazon:'com.amazon.mShop.android.shopping',
  netflix:'com.netflix.mediaclient',
  linkedin:'com.linkedin.android',
  reddit:'com.reddit.frontpage',
  discord:'com.discord',
  venmo:'com.venmo',
  paypal:'com.paypal.android.p2pmobile',
  cashapp:'com.squareup.cash','cash app':'com.squareup.cash',
  zoom:'us.zoom.videomeetings',
  calendar:'com.google.android.calendar','google calendar':'com.google.android.calendar',
};
export const KNOWN_APPS=Object.keys(ANDROID_PACKAGES);

// Loose match: exact key first, then either direction of substring containment
// so "insta" -> instagram and "open my calendar app" -> calendar both resolve.
function resolvePackage(name){
  const q=String(name||'').toLowerCase().trim().replace(/[^a-z0-9 ]/g,'');
  if(!q)return null;
  if(ANDROID_PACKAGES[q])return ANDROID_PACKAGES[q];
  for(const k of Object.keys(ANDROID_PACKAGES))if(q.includes(k)||k.includes(q))return ANDROID_PACKAGES[k];
  return null;
}

export async function openApp(name){
  if(Platform.OS!=='android')return{ok:false,reason:'app launching is Android-only right now'};
  const pkg=resolvePackage(name);
  if(!pkg)return{ok:false,reason:`don't know how to open "${name}"`};
  // action=MAIN + category=LAUNCHER is what actually says "the app's own icon
  // entry point" — a package can hold many activities, so `package=` alone
  // gives Android nothing to resolve a component against and the intent just
  // fails to launch anything, even when the package is installed and visible.
  // launchFlags 0x10200000 = FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_RESET_TASK_IF_NEEDED,
  // the standard combo for launching another app's default activity from outside it.
  // `intent:` (single colon) isn't a valid intent-URI — Android's parser
  // expects the `intent://` form (double slash) even with an empty host/path,
  // so the single-colon version likely failed to parse into anything at all,
  // silently doing nothing rather than throwing a catchable error.
  const intent=`intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${pkg};launchFlags=0x10200000;end`;
  try{await Linking.openURL(intent);return{ok:true};}
  catch(e){return{ok:false,reason:`"${name}" isn't installed`};}
}

// Opens a plain webpage — only when Mr. Burrus explicitly asks for one, never
// as a fallback from openApp above.
export async function openWebpage(url){
  const clean=String(url||'').trim();
  if(!clean)return{ok:false,reason:'no URL given'};
  const withScheme=/^https?:\/\//i.test(clean)?clean:`https://${clean}`;
  try{await Linking.openURL(withScheme);return{ok:true};}
  catch(e){return{ok:false,reason:e?.message||'failed to open'};}
}
