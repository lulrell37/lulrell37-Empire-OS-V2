// Adds a <queries> block to AndroidManifest.xml listing every app package
// Ara can launch (see src/services/appLauncher.js). Android 11+ (API 30)
// hides package-visibility info by default — without this, Linking.openURL's
// intent-based app launch can't resolve ANY of these packages, installed or
// not, and the whole "open the actual app, not a webpage" feature silently
// stops working. This is baked into the native manifest at build time, so it
// only takes effect after a fresh EAS build — it does not ship OTA.
//
// Keep this list in sync with ANDROID_PACKAGES in src/services/appLauncher.js.
const{withAndroidManifest}=require('@expo/config-plugins');

const PACKAGES=[
  'com.spotify.music',
  'com.instagram.android',
  'com.zhiliaoapp.musically',        // TikTok
  'com.google.android.youtube',
  'com.twitter.android',             // X (kept its original package on rebrand)
  'com.facebook.katana',
  'com.whatsapp',
  'com.ubercab',
  'com.ubercab.eats',
  'com.google.android.apps.maps',
  'com.waze',
  'com.google.android.gm',
  'com.amazon.mShop.android.shopping',
  'com.netflix.mediaclient',
  'com.linkedin.android',
  'com.reddit.frontpage',
  'com.discord',
  'com.venmo',
  'com.paypal.android.p2pmobile',
  'com.squareup.cash',
  'us.zoom.videomeetings',
  'com.google.android.calendar',
];

function withAppQueries(config){
  return withAndroidManifest(config,(config)=>{
    const manifest=config.modResults.manifest;
    manifest.queries=manifest.queries||[];
    let block=manifest.queries.find(q=>Array.isArray(q.package));
    if(!block){block={package:[]};manifest.queries.push(block);}
    block.package=block.package||[];
    const have=new Set(block.package.map(p=>p.$?.['android:name']));
    for(const pkg of PACKAGES){
      if(have.has(pkg))continue;
      block.package.push({$:{'android:name':pkg}});
    }
    return config;
  });
}
module.exports=withAppQueries;
