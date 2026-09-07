// STOP + DELETE for any background-job row (clip edits, video watches, builds,
// FORGE pieces). STOP shows only while the job is still running and cancels it
// where it lives (closes the GitHub issue, etc.); DELETE always shows and drops
// the local row — and stops the job first if it's still going. Both confirm.
import React from 'react';
import{View,Text,TouchableOpacity,StyleSheet,Alert}from 'react-native';

const HS={top:8,bottom:8,left:6,right:6};

export default function TaskRowActions({what='task',running=false,onStop,onDelete,accent='#C7614B'}){
  const confirmStop=()=>Alert.alert(
    `Stop this ${what}?`,
    "It won't finish — you can start it again later.",
    [{text:'Keep going',style:'cancel'},{text:'Stop',style:'destructive',onPress:()=>onStop&&onStop()}],
  );
  const confirmDelete=()=>Alert.alert(
    `Delete this ${what}?`,
    running
      ? 'Stops it and removes it from the list for good.'
      : 'Removes it from the list for good.',
    [{text:'Cancel',style:'cancel'},{text:'Delete',style:'destructive',onPress:()=>onDelete&&onDelete()}],
  );
  return(
    <View style={s.row}>
      {running&&!!onStop&&(
        <TouchableOpacity onPress={confirmStop} hitSlop={HS}>
          <Text style={[s.stop,{color:accent}]}>STOP</Text>
        </TouchableOpacity>
      )}
      {!!onDelete&&(
        <TouchableOpacity onPress={confirmDelete} hitSlop={HS}>
          <Text style={s.del}>DELETE</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s=StyleSheet.create({
  row:{flexDirection:'row',alignItems:'center',gap:10},
  stop:{fontFamily:'monospace',fontSize:8,fontWeight:'700',letterSpacing:1},
  del:{fontFamily:'monospace',fontSize:8,color:'#5a5145',letterSpacing:1},
});
