import React,{useState,useEffect}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,ScrollView,Alert,KeyboardAvoidingView,Platform}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{saveKeys,loadKeys}from '../services/keyStore';
import{saveCustomPrompt,getCustomPrompt,getApiUsage,getAllPersonaPics}from '../services/database';
import{PERSONA_LIST,getPersona}from '../personas/personas';
import useEmpireStore from '../store/useEmpireStore';
const TABS=['KEYS','PROFILES','PROMPTS','USAGE'];
export default function SettingsScreen({navigation}){
  const[tab,setTab]=useState('KEYS');
  const[claude,setClaude]=useState('');const[grok,setGrok]=useState('');const[openai,setOpenai]=useState('');const[elevenlabs,setElevenlabs]=useState('');
  const[showKey,setShowKey]=useState({});
  const[promptPersona,setPromptPersona]=useState('jarvis');const[promptText,setPromptText]=useState('');
  const[usage,setUsage]=useState([]);const[saved,setSaved]=useState(false);
  const{setPersonaPics}=useEmpireStore();
  useEffect(()=>{loadAll();},[]);
  async function loadAll(){
    const k=await loadKeys();if(k){setClaude(k.claude||'');setGrok(k.grok||'');setOpenai(k.openai||'');setElevenlabs(k.elevenlabs||'');}
    const u=await getApiUsage();setUsage(u);
    const p=await getAllPersonaPics();setPersonaPics(p);
  }
  async function saveApiKeys(){if(!claude.trim()){Alert.alert('Required','Claude API key is required.');return;}await saveKeys({claude:claude.trim(),grok:grok.trim(),openai:openai.trim(),elevenlabs:elevenlabs.trim()});setSaved(true);setTimeout(()=>setSaved(false),2000);}
  async function loadPrompt(personaId){setPromptPersona(personaId);const custom=await getCustomPrompt(personaId);if(custom)setPromptText(custom);else setPromptText(getPersona(personaId).system||'');}
  async function savePrompt(){await saveCustomPrompt(promptPersona,promptText);Alert.alert('Saved',`${getPersona(promptPersona).name} prompt updated.`);}
  async function resetPrompt(){setPromptText(getPersona(promptPersona).system||'');await saveCustomPrompt(promptPersona,getPersona(promptPersona).system||'');Alert.alert('Reset','Prompt restored to default.');}
  const totalUsage=usage.reduce((acc,u)=>({...acc,[u.provider]:{in:(acc[u.provider]?.in||0)+u.tokens_in,out:(acc[u.provider]?.out||0)+u.tokens_out}}),{});
  return(
    <SafeAreaView style={s.c} edges={['top','bottom']}>
      <View style={s.hdr}><TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity><Text style={s.title}>THE SENATE</Text><View style={{width:30}}/></View>
      <View style={s.tabs}>{TABS.map(t=>(<TouchableOpacity key={t} style={[s.tab,tab===t&&s.tabA]} onPress={()=>setTab(t)}><Text style={[s.tabT,tab===t&&s.tabTA]}>{t}</Text></TouchableOpacity>))}</View>
      <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}>
        <ScrollView contentContainerStyle={s.content}>
          {tab==='KEYS'&&<View>
            <Text style={s.secTitle}>API KEYS</Text>
            <Text style={s.secSub}>Stored securely on device only.</Text>
            {[['ANTHROPIC (CLAUDE)','Required · Jarvis, Stephanie, Atlas, Haven, Aisha, Abraham, Batman',claude,setClaude,'sk-ant-...'],['XAI (GROK)','Required · Ara, Rogue',grok,setGrok,'xai-...'],['OPENAI','Optional · Selene',openai,setOpenai,'sk-...'],['ELEVENLABS','Optional · Voice',elevenlabs,setElevenlabs,'...']].map(([label,sub,val,setter,ph])=>(
              <View key={label} style={s.keyField}>
                <View style={s.keyHdr}><Text style={s.keyLabel}>{label}</Text><TouchableOpacity onPress={()=>setShowKey(prev=>({...prev,[label]:!prev[label]}))}><Text style={s.showHide}>{showKey[label]?'HIDE':'SHOW'}</Text></TouchableOpacity></View>
                <Text style={s.keySub}>{sub}</Text>
                <TextInput style={s.keyInput} value={val} onChangeText={setter} placeholder={ph} placeholderTextColor="#1A1A1A" secureTextEntry={!showKey[label]} autoCapitalize="none" autoCorrect={false}/>
              </View>
            ))}
            <TouchableOpacity style={s.saveBtn} onPress={saveApiKeys}><Text style={s.saveBtnT}>{saved?'✓ SAVED':'SAVE KEYS'}</Text></TouchableOpacity>
          </View>}
          {tab==='PROFILES'&&<View>
            <Text style={s.secTitle}>PERSONA PROFILES</Text>
            <Text style={s.secSub}>Profile pictures for each persona.</Text>
            <View style={s.picsGrid}>
              {PERSONA_LIST.map(p=>(<TouchableOpacity key={p.id} style={s.picItem} onPress={()=>Alert.alert('Coming Soon','Photo upload coming in next update.')}>
                <View style={[s.picAvatar,{borderColor:p.color}]}><Text style={[s.picInitial,{color:p.color}]}>{p.icon}</Text></View>
                <Text style={[s.picName,{color:p.color}]}>{p.name.split('.').filter(Boolean)[0]}</Text>
              </TouchableOpacity>))}
            </View>
          </View>}
          {tab==='PROMPTS'&&<View>
            <Text style={s.secTitle}>CUSTOM PROMPTS</Text>
            <Text style={s.secSub}>Override any persona system prompt.</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom:12}} contentContainerStyle={{gap:8,paddingVertical:4}}>
              {PERSONA_LIST.map(p=>(<TouchableOpacity key={p.id} style={[s.personaChip,promptPersona===p.id&&{borderColor:p.color,backgroundColor:p.color+'11'}]} onPress={()=>loadPrompt(p.id)}><Text style={[s.personaChipT,promptPersona===p.id&&{color:p.color}]}>{p.name.split('.').filter(Boolean)[0]}</Text></TouchableOpacity>))}
            </ScrollView>
            <Text style={s.editingLabel}>Editing: {getPersona(promptPersona).name}</Text>
            <TextInput style={s.promptInput} value={promptText} onChangeText={setPromptText} multiline placeholder="Enter custom system prompt..." placeholderTextColor="#222"/>
            <View style={{flexDirection:'row',gap:10,marginTop:12}}>
              <TouchableOpacity style={[s.saveBtn,{flex:1,marginTop:0}]} onPress={savePrompt}><Text style={s.saveBtnT}>SAVE</Text></TouchableOpacity>
              <TouchableOpacity style={[s.saveBtn,{flex:1,marginTop:0,backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={resetPrompt}><Text style={[s.saveBtnT,{color:'#555'}]}>RESET</Text></TouchableOpacity>
            </View>
          </View>}
          {tab==='USAGE'&&<View>
            <Text style={s.secTitle}>API USAGE</Text>
            <Text style={s.secSub}>Token consumption by provider</Text>
            {Object.entries(totalUsage).map(([provider,u])=>(<View key={provider} style={s.usageCard}><Text style={s.usageProvider}>{provider.toUpperCase()}</Text><View style={s.usageRow}><Text style={s.usageLabel}>Input</Text><Text style={s.usageVal}>{u.in.toLocaleString()}</Text></View><View style={s.usageRow}><Text style={s.usageLabel}>Output</Text><Text style={s.usageVal}>{u.out.toLocaleString()}</Text></View></View>))}
            {Object.keys(totalUsage).length===0&&<Text style={s.empty}>No usage recorded yet.</Text>}
          </View>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const s=StyleSheet.create({
  c:{flex:1,backgroundColor:'#000'},
  hdr:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  back:{fontSize:20,color:'#E8C98A'},title:{fontFamily:'monospace',fontSize:13,color:'#E8C98A',fontWeight:'700',letterSpacing:3},
  tabs:{flexDirection:'row',borderBottomWidth:1,borderBottomColor:'#0D0D0D',paddingHorizontal:12,paddingTop:8,gap:6},
  tab:{paddingHorizontal:14,paddingVertical:6,borderRadius:4,borderWidth:1,borderColor:'#111',marginBottom:8},
  tabA:{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'},tabT:{fontFamily:'monospace',fontSize:9,color:'#333',letterSpacing:1},tabTA:{color:'#E8C98A'},
  content:{padding:18,paddingBottom:40},
  secTitle:{fontFamily:'monospace',fontSize:11,color:'#E8C98A',letterSpacing:3,marginBottom:4},
  secSub:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1,marginBottom:18},
  keyField:{marginBottom:18},keyHdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:3},
  keyLabel:{fontFamily:'monospace',fontSize:9,color:'#666',letterSpacing:2},showHide:{fontFamily:'monospace',fontSize:8,color:'#333'},
  keySub:{fontFamily:'monospace',fontSize:7,color:'#222',letterSpacing:1,marginBottom:6},
  keyInput:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,paddingHorizontal:12,paddingVertical:10,color:'#CCC',fontSize:12,fontFamily:'monospace'},
  saveBtn:{backgroundColor:'#E8C98A',padding:14,borderRadius:6,alignItems:'center',marginTop:20},
  saveBtnT:{fontFamily:'monospace',fontWeight:'700',color:'#000',fontSize:11,letterSpacing:3},
  picsGrid:{flexDirection:'row',flexWrap:'wrap',gap:16},
  picItem:{width:'28%',alignItems:'center'},
  picAvatar:{width:56,height:56,borderRadius:28,borderWidth:2,alignItems:'center',justifyContent:'center',marginBottom:6},
  picInitial:{fontFamily:'monospace',fontSize:16,fontWeight:'700'},picName:{fontFamily:'monospace',fontSize:7,letterSpacing:1,textAlign:'center'},
  personaChip:{paddingHorizontal:12,paddingVertical:6,borderRadius:4,borderWidth:1,borderColor:'#1A1A1A'},
  personaChipT:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1},
  editingLabel:{fontFamily:'monospace',fontSize:9,color:'#555',letterSpacing:2,marginBottom:10},
  promptInput:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,padding:14,color:'#CCC',fontSize:12,minHeight:200,textAlignVertical:'top'},
  usageCard:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,padding:16,marginBottom:12},
  usageProvider:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',letterSpacing:3,marginBottom:10},
  usageRow:{flexDirection:'row',justifyContent:'space-between',paddingVertical:4},
  usageLabel:{fontFamily:'monospace',fontSize:9,color:'#444'},usageVal:{fontFamily:'monospace',fontSize:9,color:'#E8C98A'},
  empty:{fontFamily:'monospace',fontSize:10,color:'#222',textAlign:'center',marginTop:40,letterSpacing:1},
});
