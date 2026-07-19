import React,{useEffect,useRef}from 'react';
import{View,Text,StyleSheet,Animated,TouchableOpacity,Image,Dimensions}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
const{width,height}=Dimensions.get('window');
export default function SplashScreen({navigation}){
  const fade=useRef(new Animated.Value(0)).current;
  const logoScale=useRef(new Animated.Value(0.8)).current;
  const textFade=useRef(new Animated.Value(0)).current;
  const btnFade=useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    Animated.sequence([
      Animated.parallel([Animated.timing(fade,{toValue:1,duration:800,useNativeDriver:true}),Animated.spring(logoScale,{toValue:1,tension:60,friction:8,useNativeDriver:true})]),
      Animated.timing(textFade,{toValue:1,duration:600,useNativeDriver:true}),
      Animated.timing(btnFade,{toValue:1,duration:500,useNativeDriver:true}),
    ]).start();
  },[]);
  return(
    <View style={s.container}>
      <SafeAreaView style={s.safe}>
        <Animated.View style={[s.content,{opacity:fade}]}>
          <Animated.View style={[s.logoContainer,{transform:[{scale:logoScale}]}]}>
            <Image source={require('../../assets/icon.png')} style={s.logo} resizeMode="contain"/>
          </Animated.View>
          <Animated.View style={{opacity:textFade}}>
            <Text style={s.title}>EMPIRE OS</Text>
            <Text style={s.subtitle}>THE KINGDOM</Text>
            <View style={s.divider}/>
            <Text style={s.tagline}>Built for one. Built to win.</Text>
          </Animated.View>
          <Animated.View style={[s.btnContainer,{opacity:btnFade}]}>
            <TouchableOpacity style={s.enterBtn} onPress={()=>navigation.replace('Map')} activeOpacity={0.8}>
              <Text style={s.enterBtnText}>ENTER THE EMPIRE</Text>
            </TouchableOpacity>
          </Animated.View>
          <Animated.Text style={[s.version,{opacity:textFade}]}>V2 · {new Date().getFullYear()}</Animated.Text>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}
const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  safe:{flex:1,justifyContent:'center'},
  content:{alignItems:'center',paddingHorizontal:40},
  logoContainer:{marginBottom:32},
  logo:{width:160,height:160},
  title:{fontFamily:'monospace',fontSize:36,fontWeight:'700',color:'#E8C98A',letterSpacing:8,textAlign:'center'},
  subtitle:{fontFamily:'monospace',fontSize:11,color:'#555',letterSpacing:6,textAlign:'center',marginTop:4},
  divider:{width:80,height:1,backgroundColor:'#E8C98A44',alignSelf:'center',marginVertical:24},
  tagline:{fontFamily:'monospace',fontSize:12,color:'#444',letterSpacing:2,textAlign:'center',marginBottom:48},
  btnContainer:{width:'100%',alignItems:'center'},
  enterBtn:{backgroundColor:'#E8C98A',paddingVertical:18,paddingHorizontal:48,borderRadius:2,width:'100%',alignItems:'center'},
  enterBtnText:{fontFamily:'monospace',fontWeight:'700',color:'#000',fontSize:14,letterSpacing:4},
  version:{fontFamily:'monospace',fontSize:9,color:'#222',letterSpacing:3,marginTop:32},
});
