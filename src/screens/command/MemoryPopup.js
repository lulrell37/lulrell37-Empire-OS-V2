// A single memory in a centered card. Swipe either way — or tap the trash — to
// delete it; the caller does the optimistic remove + undo.
import React from 'react';
import{View,Text,StyleSheet,Modal,ScrollView,TouchableOpacity,Dimensions}from 'react-native';
import{Swipeable,GestureHandlerRootView}from 'react-native-gesture-handler';
import{Feather}from '@expo/vector-icons';
import{categoryMeta}from '../../services/memoryCategories';
import{colors,space,radius,FONTS}from '../../theme';

function parts(content){
  const raw=String(content||'').trim();
  const m=raw.match(/^\s*(?:YOU|USER)\s*:\s*([\s\S]*?)\n\s*([A-Z][A-Za-z.\s]{1,22}):\s*([\s\S]*)$/);
  if(m)return{you:m[1].trim(),who:m[2].trim(),reply:m[3].trim()};
  return{you:'',who:'',reply:raw};
}

export default function MemoryPopup({memory,onClose,onDelete}){
  if(!memory)return null;
  const cm=categoryMeta(memory.category);
  const{you,who,reply}=parts(memory.content);
  let kw=[];try{kw=JSON.parse(memory.keywords||'[]').slice(0,6);}catch{}
  const del=()=>{onDelete&&onDelete(memory);onClose&&onClose();};
  const action=()=>(<View style={[s.act,{backgroundColor:colors.danger}]}><Feather name="trash-2" size={16} color="#000"/></View>);

  return(
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={{flex:1}}>
        <TouchableOpacity style={s.over} activeOpacity={1} onPress={onClose}>
          <TouchableOpacity style={s.cardWrap} activeOpacity={1} onPress={()=>{}}>
            <Swipeable friction={1.6} rightThreshold={44} leftThreshold={44}
              renderRightActions={action} renderLeftActions={action}
              onSwipeableOpen={del}>
              <View style={s.card}>
                <View style={[s.accent,{backgroundColor:cm.color}]}/>
                <View style={s.head}>
                  <View style={[s.tag,{borderColor:cm.color+'55'}]}>
                    <View style={[s.tagDot,{backgroundColor:cm.color}]}/>
                    <Text style={[s.tagT,{color:cm.color}]}>{cm.label.toUpperCase()}</Text>
                  </View>
                  <Text style={s.date}>{memory.date}</Text>
                  <TouchableOpacity onPress={del} hitSlop={{top:10,bottom:10,left:10,right:10}}>
                    <Feather name="trash-2" size={14} color={colors.textDim}/>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={onClose} hitSlop={{top:10,bottom:10,left:10,right:10}}>
                    <Feather name="x" size={16} color={colors.textDim}/>
                  </TouchableOpacity>
                </View>

                <ScrollView style={s.scroll} contentContainerStyle={s.scrollPad}
                  showsVerticalScrollIndicator bounces>
                  {!!you&&<>
                    <Text style={s.speaker}>YOU</Text>
                    <Text style={s.you} selectable>{you}</Text>
                  </>}
                  {!!reply&&<>
                    <Text style={[s.speaker,{color:cm.color,marginTop:you?space.lg:0}]}>{(who||'MEMORY').toUpperCase()}</Text>
                    <Text style={s.reply} selectable>{reply}</Text>
                  </>}
                </ScrollView>

                {kw.length>0&&(
                  <View style={s.kwRow}>
                    {kw.map(k=>(<Text key={k} style={s.kw}>{k}</Text>))}
                  </View>
                )}
              </View>
            </Swipeable>
          </TouchableOpacity>
        </TouchableOpacity>
      </GestureHandlerRootView>
    </Modal>
  );
}

const s=StyleSheet.create({
  over:{flex:1,backgroundColor:'rgba(0,0,0,0.84)',alignItems:'center',justifyContent:'center',padding:space.xl},
  cardWrap:{width:'88%',maxHeight:'88%'},
  card:{backgroundColor:colors.card,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.lg,overflow:'hidden'},
  accent:{height:3},
  head:{flexDirection:'row',alignItems:'center',gap:space.md,paddingHorizontal:space.md,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  tag:{flexDirection:'row',alignItems:'center',gap:5,borderWidth:1,borderRadius:radius.sm,paddingHorizontal:6,paddingVertical:3},
  tagDot:{width:5,height:5,borderRadius:3},
  tagT:{fontFamily:FONTS.monoMed,fontSize:7.5,letterSpacing:1.5},
  date:{fontFamily:FONTS.mono,fontSize:9,letterSpacing:1,color:colors.textDim,flex:1},
  scroll:{maxHeight:Math.round(Dimensions.get('window').height*0.62)},
  scrollPad:{padding:space.lg},
  speaker:{fontFamily:FONTS.monoMed,fontSize:7.5,letterSpacing:3,color:colors.textDim,marginBottom:6},
  you:{fontFamily:FONTS.mono,fontSize:13,lineHeight:21,color:colors.text},
  reply:{fontFamily:FONTS.mono,fontSize:13,lineHeight:21,color:colors.textMuted},
  kwRow:{flexDirection:'row',flexWrap:'wrap',gap:5,paddingHorizontal:space.lg,paddingBottom:space.lg,paddingTop:space.xs,borderTopWidth:1,borderTopColor:colors.hairline},
  kw:{fontFamily:FONTS.mono,fontSize:8,letterSpacing:0.5,color:colors.textDim,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.sm,paddingHorizontal:6,paddingVertical:2},
  act:{width:72,alignItems:'center',justifyContent:'center'},
});
