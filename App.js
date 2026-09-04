import './errorHandler';
import ErrorBoundary from './ErrorBoundary';
import ErrorBanner,{reportError}from './ErrorBanner';
import React,{useEffect,useState}from 'react';
import{AppState}from 'react-native';
import{StatusBar}from 'expo-status-bar';
import{NavigationContainer,createNavigationContainerRef}from '@react-navigation/native';
import{createNativeStackNavigator}from '@react-navigation/native-stack';
import*as SplashScreen from 'expo-splash-screen';
import*as Font from 'expo-font';
import{FONT_MAP}from './src/theme';
import{GestureHandlerRootView}from 'react-native-gesture-handler';
import{SafeAreaProvider}from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SplashScreenComponent from './src/screens/SplashScreen';
import EmpireCityScreen from './src/screens/EmpireCityScreen';
import CommandScreen from './src/screens/CommandScreen';
import HUDScreen from './src/screens/HUDScreen';
import LaboratoryScreen from './src/screens/LaboratoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import{initDatabase}from './src/services/database';
import{loadKeys}from './src/services/keyStore';
import{runSync,initSyncStatus}from './src/services/sync';
import{registerPushToken}from './src/services/push';
import{tlInit}from './src/services/tradeLocker';
import{startAutoTrader,stopAutoTrader}from './src/services/autoTrader';
import{startAutoScout,stopAutoScout}from './src/services/autoScout';
import{refreshDailyBriefing}from './src/services/dailyBriefing';
import{importInboundForm}from './src/services/inbound';
import{pushLeadsToSheet}from './src/services/leadsSheet';
import{getAllPersonaPics}from './src/services/database';
import useEmpireStore from './src/store/useEmpireStore';
import{recentCrashCount}from './src/services/crashLog';
import HudFloatLayer from './src/screens/hud/HudFloatLayer';
SplashScreen.preventAutoHideAsync();
const Stack=createNativeStackNavigator();
const navigationRef=createNavigationContainerRef();
const NAV_STATE_KEY='EMPIRE_OS_NAV_STATE_V2';
export default function App(){
  const[isReady,setIsReady]=useState(false);
  const[hasKeys,setHasKeys]=useState(false);
  const[navReady,setNavReady]=useState(false);
  const[initialNavState,setInitialNavState]=useState();
  const{setPersonaPics}=useEmpireStore();
  useEffect(()=>{
    async function prepare(){
      try{
        await Font.loadAsync(FONT_MAP).catch(e=>{console.warn('Font load failed, using fallback:',e.message);});
        await initDatabase();const keys=await loadKeys();setHasKeys(!!(keys?.claude));const pics=await getAllPersonaPics();setPersonaPics(pics);
        tlInit().catch(()=>{}); // learn the TradeLocker login state + warm the session
        await initSyncStatus().catch(()=>{});
        runSync().catch(()=>{}); // no-op unless a backend is configured
        registerPushToken().catch(()=>{}); // no-op unless a backend is configured
      }
      catch(e){console.warn('Init error:',e);reportError('Init error: '+e.message);}
      finally{setIsReady(true);await SplashScreen.hideAsync();}
    }
    prepare();
  },[]);
  useEffect(()=>{
    async function restoreNavState(){
      try{
        // Crash-loop guard: if we've crashed 2+ times in the last 30s, the saved
        // screen is likely what's crashing — start clean instead.
        const crashes=await recentCrashCount(30000).catch(()=>0);
        if(crashes>=2){setNavReady(true);return;}
        const saved=await AsyncStorage.getItem(NAV_STATE_KEY);
        if(saved)setInitialNavState(JSON.parse(saved));
      }catch(e){}
      finally{setNavReady(true);}
    }
    restoreNavState();
  },[]);
  useEffect(()=>{
    // Sync on every return to the foreground + a gentle background interval.
    const sub=AppState.addEventListener('change',(st)=>{if(st==='active'){runSync().catch(()=>{});refreshDailyBriefing().catch(()=>{});importInboundForm().catch(()=>{});pushLeadsToSheet().catch(()=>{});}});
    const iv=setInterval(()=>{runSync().catch(()=>{});},120000);
    const inb=setInterval(()=>{importInboundForm().catch(()=>{});},300000);
    const lsh=setInterval(()=>{pushLeadsToSheet().catch(()=>{});},300000);
    setTimeout(()=>importInboundForm().catch(()=>{}),9000);
    setTimeout(()=>pushLeadsToSheet().catch(()=>{}),10000);
    // Daily HUD content — Stephanie (word + fact), Abraham (verse). Once/day, no repeats.
    setTimeout(()=>refreshDailyBriefing().catch(()=>{}),6000);
    return()=>{sub.remove();clearInterval(iv);clearInterval(inb);clearInterval(lsh);};
  },[]);
  useEffect(()=>{
    // A.T.L.A.S. auto-trader — only actually runs when enabled in Settings (demo only).
    startAutoTrader().catch(()=>{});
    // S.C.O.U.T. auto-scout — only runs when enabled in Settings › OUTREACH.
    startAutoScout().catch(()=>{});
    const sub=AppState.addEventListener('change',(st)=>{
      if(st==='active'){startAutoTrader().catch(()=>{});startAutoScout().catch(()=>{});}
      else{stopAutoTrader();stopAutoScout();}
    });
    return()=>{sub.remove();stopAutoTrader();stopAutoScout();};
  },[]);
  if(!isReady||!navReady)return null;
  return(
    <ErrorBoundary>
    <ErrorBanner />
    <GestureHandlerRootView style={{flex:1}}>
      <SafeAreaProvider>
        <NavigationContainer
          ref={navigationRef}
          initialState={initialNavState}
          onStateChange={(state)=>{AsyncStorage.setItem(NAV_STATE_KEY,JSON.stringify(state)).catch(()=>{});}}
        >
          <StatusBar style="light" backgroundColor="#000"/>
          <Stack.Navigator initialRouteName={hasKeys?'Map':'Splash'} screenOptions={{headerShown:false,animation:'fade',animationDuration:320,contentStyle:{backgroundColor:'#000'}}}>
            <Stack.Screen name="Splash" component={SplashScreenComponent}/>
            <Stack.Screen name="Map" component={EmpireCityScreen}/>
            <Stack.Screen name="Command" component={CommandScreen}/>
            <Stack.Screen name="HUD" component={HUDScreen}/>
            <Stack.Screen name="Laboratory" component={LaboratoryScreen}/>
            <Stack.Screen name="Settings" component={SettingsScreen}/>
          </Stack.Navigator>
          <HudFloatLayer navRef={navigationRef}/>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
