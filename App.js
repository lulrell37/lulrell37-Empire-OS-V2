import ErrorBanner from './ErrorBanner';
// inside your root render, as the first/topmost child:
<ErrorBanner />
import React,{useEffect,useState}from 'react';
import{StatusBar}from 'expo-status-bar';
import{NavigationContainer}from '@react-navigation/native';
import{createNativeStackNavigator}from '@react-navigation/native-stack';
import*as SplashScreen from 'expo-splash-screen';
import{GestureHandlerRootView}from 'react-native-gesture-handler';
import{SafeAreaProvider}from 'react-native-safe-area-context';
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
SplashScreen.preventAutoHideAsync();
const Stack=createNativeStackNavigator();
export default function App(){
  const[isReady,setIsReady]=useState(false);
  const[hasKeys,setHasKeys]=useState(false);
  const{setPersonaPics}=useEmpireStore();
  useEffect(()=>{
    async function prepare(){
      try{await initDatabase();const keys=await loadKeys();setHasKeys(!!(keys?.claude));const pics=await getAllPersonaPics();setPersonaPics(pics);}
      catch(e){console.warn('Init error:',e);}
      finally{setIsReady(true);await SplashScreen.hideAsync();}
    }
    prepare();
  },[]);
  if(!isReady)return null;
  return(
    <GestureHandlerRootView style={{flex:1}}>
      <SafeAreaProvider>
        <NavigationContainer>
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
  );
}
