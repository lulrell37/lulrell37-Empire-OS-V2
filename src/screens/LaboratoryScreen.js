// The Laboratory — the 3D diagram, pulled out of the HUD panel carousel into
// its own building on the Empire city map. All the behaviour (model generation,
// tap-to-isolate, ask Jarvis) lives in DiagramPanel and is unchanged; this is
// just the full-screen shell around it.
import React from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{Feather}from '@expo/vector-icons';
import{colors,space,FONTS}from '../theme';
import DiagramPanel from './hud/DiagramPanel';
import Boundary from './hud/Boundary';

export default function LaboratoryScreen({navigation}){
  return(
    <SafeAreaView style={s.c} edges={['top','bottom']}>
      <View style={s.hdr}>
        <TouchableOpacity onPress={()=>navigation.navigate('Map')} hitSlop={{top:12,bottom:12,left:12,right:12}}>
          <Feather name="arrow-left" size={18} color={colors.gold}/>
        </TouchableOpacity>
        <Text style={s.title}>THE LABORATORY</Text>
        <View style={{width:18}}/>
      </View>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Boundary label="The laboratory">
          <DiagramPanel/>
        </Boundary>
      </ScrollView>
    </SafeAreaView>
  );
}

const s=StyleSheet.create({
  c:{flex:1,backgroundColor:colors.bg},
  hdr:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:space.lg,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  title:{fontFamily:FONTS.monoMed,fontSize:12,color:colors.gold,letterSpacing:4},
  body:{padding:space.lg,paddingBottom:space.xxxl},
});
