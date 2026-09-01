// A single memory shown in a small centered window — not a full-screen sheet.
// Swipe the card either way to delete it; the caller handles the optimistic
// remove + undo. Used from the Brain web (OrbZoom) and the Library list.
import React from 'react';
import{View,Text,StyleSheet,Modal,ScrollView,TouchableOpacity}from 'react-native';
import{Swipeable,GestureHandlerRootView}from 'react-native-gesture-handler';
import{categoryMeta}from '../../services/memoryCategories';

export default function MemoryPopup({memory,onClose,onDelete}){
  if(!memory)return null;
  const cm=categoryMeta(memory.category);
  const act=()=>(<View style={s.act}><Text style={s.actT}>DELETE</Text></View>);
  return(
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={{flex:1}}>
      <TouchableOpacity style={s.over} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={s.cardWrap} activeOpacity={1} onPress={()=>{}}>
          <Swipeable
            friction={1.6} rightThreshold={40} leftThreshold={40}
            renderRightActions={act} renderLeftActions={act}
            onSwipeableOpen={()=>{onDelete&&onDelete(memory);onClose&&onClose();}}>
            <View style={s.card}>
              <View style={s.hd}>
                <Text style={[s.tag,{color:cm.color,borderColor:cm.color+'55'}]}>{cm.label.toUpperCase()}</Text>
                <Text style={s.date}>{memory.date}</Text>
                <TouchableOpacity onPress={onClose} hitSlop={{top:10,bottom:10,left:10,right:10}}><Text style={s.x}>×</Text></TouchableOpacity>
              </View>
              <ScrollView style={s.scroll} contentContainerStyle={{padding:16}}>
                <Text style={s.body} selectable>{memory.content}</Text>
              </ScrollView>
            </View>
          </Swipeable>
        </TouchableOpacity>
      </TouchableOpacity>
      </GestureHandlerRootView>
    </Modal>
  );
}

const s=StyleSheet.create({
  over:{flex:1,backgroundColor:'rgba(0,0,0,0.82)',alignItems:'center',justifyContent:'center',padding:20},
  cardWrap:{width:'86%',maxHeight:'55%'},
  card:{backgroundColor:'#0A0A0A',borderWidth:1,borderColor:'#1E1E1E',borderRadius:12,overflow:'hidden'},
  hd:{flexDirection:'row',alignItems:'center',gap:10,padding:12,borderBottomWidth:1,borderBottomColor:'#141414'},
  tag:{fontFamily:'monospace',fontSize:8,letterSpacing:1,borderWidth:1,borderRadius:3,paddingHorizontal:5,paddingVertical:1},
  date:{fontFamily:'monospace',fontSize:9,color:'#444',flex:1},
  x:{color:'#666',fontSize:20,lineHeight:20},
  scroll:{maxHeight:220},
  body:{color:'#CCC',fontSize:14,lineHeight:22},
  hint:{fontFamily:'monospace',fontSize:7,color:'#333',letterSpacing:2,textAlign:'center',paddingVertical:8,borderTopWidth:1,borderTopColor:'#141414'},
  act:{flex:1,backgroundColor:'#C7614B',alignItems:'center',justifyContent:'center',paddingHorizontal:22},
  actT:{fontFamily:'monospace',fontSize:10,color:'#000',fontWeight:'700',letterSpacing:2},
});
