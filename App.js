import './errorHandler';
import ErrorBoundary from './ErrorBoundary';
import ErrorBanner,{reportError}from './ErrorBanner';
import React,{useEffect,useState}from 'react';
import{StatusBar}from 'expo-status-bar';
import{NavigationContainer}from '@react-navigation/native';
import{createNativeStackNavigator}from '@react-navigation/native-stack';
import*as SplashScreen from 'expo-splash-screen';
import*as Font from 'expo-font';
import{FONT_MAP}from './src/theme';
import{GestureHandlerRootView}from 'react-native-gesture-handler';
import{SafeAreaProvider}from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SplashScreenComponent from './src/screens/SplashScreen';
import MapScreen from './src/screens/MapScreen';
import CommandScreen from './src/screens/CommandScreen';
import HUDScreen from './src/screens/HUDScreen';
import MemoryScreen from './src/screens/MemoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import{initDatabase}from './src/services/database';
import{loadKeys}from './src/services/keyStore';
import{getAllPersonaPics}from './src/services/database';
import useEmpireStore from './src/store/useEmpireStore';
import{recentCrashCount}from './src/services/crashLog';
SplashScreen.preventAutoHideAsync();
const Stack=createNativeStackNavigator();
const NAV_STATE_KEY='EMPIRE_OS_NAV_STATE_V1';
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
  if(!isReady||!navReady)return null;
  return(
    <ErrorBoundary>
    <ErrorBanner />
    <GestureHandlerRootView style={{flex:1}}>
      <SafeAreaProvider>
        <NavigationContainer
          initialState={initialNavState}
          onStateChange={(state)=>{AsyncStorage.setItem(NAV_STATE_KEY,JSON.stringify(state)).catch(()=>{});}}
        >
          <StatusBar style="light" backgroundColor="#000"/>
          <Stack.Navigator initialRouteName={hasKeys?'Map':'Splash'} screenOptions={{headerShown:false,animation:'fade',contentStyle:{backgroundColor:'#000'}}}>
            <Stack.Screen name="Splash" component={SplashScreenComponent}/>
            <Stack.Screen name="Map" component={MapScreen}/>
            <Stack.Screen name="Command" component={CommandScreen} options={{animation:'slide_from_right'}}/>
            <Stack.Screen name="HUD" component={HUDScreen} options={{animation:'slide_from_bottom'}}/>
            <Stack.Screen name="Memory" component={MemoryScreen} options={{animation:'slide_from_right'}}/>
            <Stack.Screen name="Settings" component={SettingsScreen} options={{animation:'slide_from_right'}}/>
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
