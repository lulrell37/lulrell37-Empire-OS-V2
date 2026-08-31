// A HUD panel detached into a free-floating card: drag to move, pinch to
// zoom, tap/drag to bring to front, dock button to snap back into the carousel.
// Position and scale are reported up via onPersist (on gesture end only).
import React from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,Dimensions}from 'react-native';
import Animated,{useSharedValue,useAnimatedStyle,withTiming,runOnJS}from 'react-native-reanimated';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{Feather}from '@expo/vector-icons';
import{colors,space,radius,FONTS}from '../../theme';

const{width,height}=Dimensions.get('window');
const CARD_W=Math.min(340,width-28);
const MAX_H=height*0.52;

export default function FloatingCard({title,initial,z=0,onFront,onPersist,onDock,children}){
  const tx=useSharedValue(initial?.x??24);
  const ty=useSharedValue(initial?.y??24);
  const scale=useSharedValue(initial?.scale??1);
  const startX=useSharedValue(0);
  const startY=useSharedValue(0);
  const startS=useSharedValue(1);

  const pan=Gesture.Pan()
    .onStart(()=>{
      startX.value=tx.value;
      startY.value=ty.value;
      runOnJS(onFront)();
    })
    .onUpdate(e=>{
      tx.value=startX.value+e.translationX;
      ty.value=startY.value+e.translationY;
    })
    .onEnd(()=>{
      const maxX=width-64;
      const minX=-(CARD_W-64);
      const maxY=height-140;
      const minY=-24;
      if(tx.value>maxX)tx.value=withTiming(maxX);
      else if(tx.value<minX)tx.value=withTiming(minX);
      if(ty.value>maxY)ty.value=withTiming(maxY);
      else if(ty.value<minY)ty.value=withTiming(minY);
      runOnJS(onPersist)({x:tx.value,y:ty.value});
    });

  const pinch=Gesture.Pinch()
    .onStart(()=>{startS.value=scale.value;})
    .onUpdate(e=>{
      const next=startS.value*e.scale;
      scale.value=next<0.6?0.6:next>2.2?2.2:next;
    })
    .onEnd(()=>{runOnJS(onPersist)({scale:scale.value});});

  const gesture=Gesture.Simultaneous(pan,pinch);

  const animStyle=useAnimatedStyle(()=>({
    transform:[{translateX:tx.value},{translateY:ty.value},{scale:scale.value}],
  }));

  return(
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.card,{zIndex:z},animStyle]}>
        <View style={styles.bar}>
          <Feather name="move" size={11} color={colors.textDim}/>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={onDock} hitSlop={{top:10,bottom:10,left:10,right:10}}>
            <Feather name="minimize-2" size={13} color={colors.gold}/>
          </TouchableOpacity>
        </View>
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {children}
        </ScrollView>
      </Animated.View>
    </GestureDetector>
  );
}

const styles=StyleSheet.create({
  card:{
    position:'absolute',
    width:CARD_W,
    maxHeight:MAX_H,
    backgroundColor:colors.card,
    borderWidth:1,
    borderColor:colors.hairlineGold,
    borderRadius:radius.lg,
    shadowColor:colors.gold,
    shadowOpacity:0.22,
    shadowRadius:18,
    shadowOffset:{width:0,height:8},
    elevation:14,
  },
  bar:{
    flexDirection:'row',
    alignItems:'center',
    gap:space.sm,
    paddingHorizontal:space.md,
    paddingVertical:space.sm,
    borderBottomWidth:1,
    borderBottomColor:colors.hairline,
  },
  title:{flex:1,fontFamily:FONTS.monoMed,fontSize:10,color:colors.gold,letterSpacing:2},
  body:{maxHeight:MAX_H-42},
  bodyContent:{padding:space.lg},
});
