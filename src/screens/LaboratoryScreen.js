// The Laboratory — two benches:
//  IMAGE: put a photo up and talk it through, live, with any persona about
//         exactly the part you're looking at (screens/lab/ImageLab.js).
//  3D:    the 3D diagram — generate a model from a description, or from the
//         photo via IMAGE's MAKE 3D (behaviour lives in DiagramPanel).
// Both stay mounted (3D from its first visit) so a model building from a photo, or a live conversation,
// survives switching tabs.
import React,{useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView,KeyboardAvoidingView,Platform}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{Feather}from '@expo/vector-icons';
import{colors,space,FONTS,radius}from '../theme';
import DiagramPanel from './hud/DiagramPanel';
import ImageLab from './lab/ImageLab';
import Boundary from './hud/Boundary';

export default function LaboratoryScreen({navigation}){
  const[tab,setTab]=useState('image');
  const[modelReady,setModelReady]=useState(false);
  // The GL view is created on the first visit to 3D (a GL surface made while
  // hidden can come up 0x0), then stays mounted. A photo model finished before
  // then waits in the store and loads as soon as it's up.
  const[seen3d,setSeen3d]=useState(false);
  const go=(t)=>{setTab(t);if(t==='3d'){setModelReady(false);setSeen3d(true);}};
  return(
    <SafeAreaView style={s.c} edges={['top','bottom']}>
      <View style={s.hdr}>
        <TouchableOpacity onPress={()=>navigation.navigate('Map')} hitSlop={{top:12,bottom:12,left:12,right:12}}>
          <Feather name="arrow-left" size={18} color={colors.gold}/>
        </TouchableOpacity>
        <Text style={s.title}>THE LABORATORY</Text>
        <View style={{width:18}}/>
      </View>
      <View style={s.tabs}>
        {[['image','IMAGE'],['3d','3D']].map(([id,label])=>(
          <TouchableOpacity key={id} onPress={()=>go(id)} style={[s.tab,tab===id&&s.tabOn]} activeOpacity={0.7}>
            <Text style={[s.tabT,tab===id&&s.tabTOn]}>{label}</Text>
            {id==='3d'&&modelReady&&<View style={s.badge}><Text style={s.badgeT}>READY</Text></View>}
          </TouchableOpacity>
        ))}
      </View>
      <KeyboardAvoidingView style={[s.pane,tab!=='image'&&s.hidden]} behavior={Platform.OS==='ios'?'padding':undefined}>
        <Boundary label="The image bench">
          <ImageLab onModelReady={()=>setModelReady(true)}/>
        </Boundary>
      </KeyboardAvoidingView>
      <ScrollView style={[tab!=='3d'&&s.hidden]} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {seen3d&&(
          <Boundary label="The laboratory">
            <DiagramPanel/>
          </Boundary>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s=StyleSheet.create({
  c:{flex:1,backgroundColor:colors.bg},
  hdr:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:space.lg,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  title:{fontFamily:FONTS.monoMed,fontSize:12,color:colors.gold,letterSpacing:4},
  tabs:{flexDirection:'row',gap:space.sm,paddingHorizontal:space.lg,paddingTop:space.md},
  tab:{flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:space.lg,paddingVertical:7,borderRadius:radius.sm,borderWidth:1,borderColor:colors.hairline},
  tabOn:{borderColor:colors.gold,backgroundColor:colors.gold+'14'},
  tabT:{fontFamily:FONTS.monoMed,fontSize:10,color:colors.textDim,letterSpacing:3},
  tabTOn:{color:colors.gold},
  badge:{paddingHorizontal:5,paddingVertical:1,borderRadius:3,backgroundColor:colors.gold},
  badgeT:{fontFamily:FONTS.monoMed,fontSize:7,color:colors.bg,letterSpacing:1},
  pane:{flex:1,padding:space.lg},
  body:{padding:space.lg,paddingBottom:space.xxxl},
  hidden:{display:'none'},
});
