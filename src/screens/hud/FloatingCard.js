// A HUD panel detached into a free-floating card: drag it anywhere on screen,
// pinch OR drag the ⤡ corner handle to resize, touch to bring to front, dock
// button (⊟) to send it back into the HUD feed. Position, scale and an explicit
// width/height are reported up via onPersist (on gesture end only).
import React,{useRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Dimensions}from 'react-native';
import Animated,{useSharedValue,useAnimatedStyle,withTiming,runOnJS}from 'react-native-reanimated';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{Feather}from '@expo/vector-icons';
import{colors,space,radius,FONTS}from '../../theme';

const{width,height}=Dimensions.get('window');
const CARD_W=Math.min(340,width-28);
const MAX_H=height*0.52;
// Bounds for the corner-handle resize.
const MIN_W=200;
const MAX_W=width-16;
const MIN_H=120;
const MAX_H_RESIZE=height*0.85;

export default function FloatingCard({title,initial,z=0,onFront,onPersist,onDock,children}){
  const tx=useSharedValue(initial?.x??24);
  const ty=useSharedValue(initial?.y??24);
  const scale=useSharedValue(initial?.scale??1);
  const startX=useSharedValue(0);
  const startY=useSharedValue(0);
  const startS=useSharedValue(1);

  // Explicit size. 0 means "auto" — the card sizes to its content (capped at
  // MAX_H) until the first time the handle is dragged.
  const w=useSharedValue(initial?.w||CARD_W);
  const h=useSharedValue(initial?.h||0);
  const startW=useSharedValue(0);
  const startH=useSharedValue(0);
  const measuredH=useSharedValue(0); // last laid-out height, for a resize that starts from "auto"

  const dragRef=useRef();

  const pan=Gesture.Pan()
    .withRef(dragRef)
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
      // Put it almost anywhere — only stop it vanishing entirely. You can drag
      // from any part of the card, so keeping EDGE px on screen is enough to
      // grab it again.
      const EDGE=48;
      const maxX=width-EDGE;
      const minX=-(w.value-EDGE);
      const maxY=height-EDGE;
      const minY=-EDGE/2;
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

  // Corner handle: drag to set an explicit width/height. Blocks the card's own
  // pan so grabbing the handle resizes instead of moving.
  const resize=Gesture.Pan()
    .blocksExternalGesture(dragRef)
    .onStart(()=>{
      runOnJS(onFront)();
      startW.value=w.value;
      startH.value=h.value>0?h.value:(measuredH.value||300);
    })
    .onUpdate(e=>{
      const nw=startW.value+e.translationX;
      const nh=startH.value+e.translationY;
      w.value=nw<MIN_W?MIN_W:nw>MAX_W?MAX_W:nw;
      h.value=nh<MIN_H?MIN_H:nh>MAX_H_RESIZE?MAX_H_RESIZE:nh;
    })
    .onEnd(()=>{runOnJS(onPersist)({w:w.value,h:h.value});});

  const animStyle=useAnimatedStyle(()=>({
    width:w.value,
    height:h.value>0?h.value:undefined,
    maxHeight:h.value>0?undefined:MAX_H,
    transform:[{translateX:tx.value},{translateY:ty.value},{scale:scale.value}],
  }));
  // Body fills a fixed-height card; falls back to content-height (capped) while
  // the card is still auto-sized.
  const bodyStyle=useAnimatedStyle(()=>({
    flexGrow:h.value>0?1:0,
    maxHeight:h.value>0?undefined:MAX_H-40,
  }));

  return(
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[styles.card,{zIndex:z},animStyle]}
        onLayout={e=>{measuredH.value=e.nativeEvent.layout.height;}}
      >
        <View style={styles.bar}>
          <Feather name="move" size={11} color={colors.textDim}/>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={onDock} hitSlop={{top:10,bottom:10,left:10,right:10}}>
            <Feather name="minimize-2" size={13} color={colors.gold}/>
          </TouchableOpacity>
        </View>
        <Animated.ScrollView
          style={[styles.body,bodyStyle]}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {children}
        </Animated.ScrollView>
        <GestureDetector gesture={resize}>
          <View style={styles.handle}>
            <View style={styles.handleLineA}/>
            <View style={styles.handleLineB}/>
          </View>
        </GestureDetector>
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
    overflow:'hidden',
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
  body:{flexShrink:1},
  bodyContent:{padding:space.lg},
  handle:{
    position:'absolute',
    right:0,
    bottom:0,
    width:34,
    height:34,
    borderTopLeftRadius:radius.md,
    backgroundColor:colors.hairline,
  },
  handleLineA:{position:'absolute',right:5,bottom:5,width:13,height:1.5,backgroundColor:colors.gold,transform:[{rotate:'-45deg'}]},
  handleLineB:{position:'absolute',right:4,bottom:10,width:7,height:1.5,backgroundColor:colors.gold,transform:[{rotate:'-45deg'}]},
});
