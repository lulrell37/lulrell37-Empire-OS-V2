// THE ALMANAC — P.U.L.S.E.'s home in the city. A full-screen read of the
// Empire's numbers (revenue vs target, content, trading, outreach). The board
// itself is shared with the Canvas [SHOW_ANALYTICS] surface.
import React from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{FONTS}from '../theme';
import AnalyticsBoard from './command/canvas/AnalyticsBoard';

const ACCENT='#8FB7C9';

export default function AnalyticsScreen({navigation}){
  return(
    <SafeAreaView style={s.safe} edges={['top','bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={()=>navigation.navigate('Map')} hitSlop={{top:12,bottom:12,left:12,right:12}} activeOpacity={0.7}>
          <Text style={s.back}>‹ MAP</Text>
        </TouchableOpacity>
        <View style={s.titleWrap}>
          <Text style={s.title}>P.U.L.S.E. · THE ALMANAC</Text>
          <Text style={s.sub}>the Empire in numbers</Text>
        </View>
        <View style={{width:44}}/>
      </View>
      <AnalyticsBoard accent={ACCENT}/>
    </SafeAreaView>
  );
}

const s=StyleSheet.create({
  safe:{flex:1,backgroundColor:'#000'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:14,paddingTop:6,paddingBottom:8,borderBottomWidth:1,borderBottomColor:'#141210'},
  back:{fontFamily:FONTS.mono,fontSize:10,color:ACCENT,letterSpacing:2,width:44},
  titleWrap:{flex:1,alignItems:'center'},
  title:{fontFamily:FONTS.mono,fontSize:11,color:'#C9BEA6',letterSpacing:3},
  sub:{fontFamily:FONTS.mono,fontSize:8,color:'#6a6250',letterSpacing:1,marginTop:2},
});
