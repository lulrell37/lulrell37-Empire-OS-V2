import React,{useEffect,useRef}from 'react';
import{View,Text,StyleSheet,Animated,TouchableOpacity}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
export default function SplashScreenComponent({navigation}){
  const f=useRef(new Animated.Value(0)).current;
  useEffect(()=>{Animated.timing(f,{toValue:1,duration:1200,useNativeDriver:true}).start();},[]);
  return(
    <View style={s.c}><SafeAreaView style={s.sf}>
      <Animated.View style={[s.content,{opacity:f}]}>
        <Text style={s.crown}>♔</Text>
        <Text style={s.title}>EMPIRE OS</Text>
        <Text style={s.ver}>V2 · THE KINGDOM</Text>
        <Text style={s.tag}>Built for one. Built to win.</Text>
        <View style={s.div}/>
        <Text style={s.intro}>Your AI council awaits. Set up your API keys to enter.</Text>
        <TouchableOpacity style={s.btn} onPress={()=>navigation.replace('Settings')}>
          <Text style={s.btnT}>ENTER THE EMPIRE</Text>
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView></View>
  );
}
const s=StyleSheet.create({
  c:{flex:1,backgroundColor:'#000'},sf:{flex:1,justifyContent:'center',alignItems:'center'},
  content:{alignItems:'center',paddingHorizontal:40,width:'100%'},
  crown:{fontSize:48,color:'#E8C98A',marginBottom:16},
  title:{fontFamily:'monospace',fontSize:32,fontWeight:'700',color:'#E8C98A',letterSpacing:8,marginBottom:6},
  ver:{fontFamily:'monospace',fontSize:10,color:'#444',letterSpacing:4,marginBottom:8},
  tag:{fontFamily:'monospace',fontSize:12,color:'#333',letterSpacing:2,marginBottom:32},
  div:{width:60,height:1,backgroundColor:'#E8C98A44',marginBottom:32},
  intro:{fontFamily:'monospace',fontSize:11,color:'#444',textAlign:'center',lineHeight:20,marginBottom:40},
  btn:{backgroundColor:'#E8C98A',paddingHorizontal:40,paddingVertical:16,borderRadius:12,width:'100%',alignItems:'center'},
  btnT:{fontFamily:'monospace',fontWeight:'700',color:'#000',fontSize:13,letterSpacing:3},
});
