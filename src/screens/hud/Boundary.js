// Contains a render error to a single HUD panel instead of taking down the
// whole screen (used for the 3D diagram panel).
import React from 'react';
import{View,Text,StyleSheet}from 'react-native';
import{Feather}from '@expo/vector-icons';
import{colors,space,FONTS}from '../../theme';

export default class Boundary extends React.Component{
  state={err:null};
  static getDerivedStateFromError(err){return{err};}
  componentDidCatch(err){if(__DEV__)console.warn('Panel boundary:',err);}
  render(){
    if(this.state.err){
      return(
        <View style={styles.wrap}>
          <Feather name="alert-triangle" size={18} color={colors.danger}/>
          <Text style={styles.text}>
            {(this.props.label||'This panel')} could not load.{'\n'}
            {String(this.state.err?.message||this.state.err).slice(0,140)}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles=StyleSheet.create({
  wrap:{alignItems:'center',justifyContent:'center',paddingVertical:space.xxl,gap:space.sm},
  text:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:0.5,textAlign:'center',lineHeight:15,paddingHorizontal:space.lg},
});
