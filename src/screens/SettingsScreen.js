import React,{useState,useEffect}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,ScrollView,Alert,KeyboardAvoidingView,Platform,Image}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import*as ImagePicker from 'expo-image-picker';
import{saveKeys,loadKeys,saveGoogleToken,loadGoogleToken,clearGoogleToken,saveTradeCreds,loadTradeCreds,clearTradeCreds,saveGitHubToken,loadGitHubToken,clearGitHubToken}from '../services/keyStore';
import{tlConnect,tlReset}from '../services/tradeLocker';
import{ghVerify}from '../services/buildAgent';
import{saveCustomPrompt,getCustomPrompt,getApiUsage,getAllPersonaPics,savePersonaPic,getSetting,setSetting}from '../services/database';
import{getCrashLog,clearCrashLog}from '../services/crashLog';
import{PERSONA_LIST,getPersona}from '../personas/personas';
import{useGoogleAuth,exchangeGoogleCode,revokeGoogle}from '../services/googleAuth';
import useEmpireStore from '../store/useEmpireStore';
const TABS=['KEYS','GOOGLE','TRADING','DEV','AI','PROFILES','PROMPTS','USAGE','DIAGNOSTICS'];
export default function SettingsScreen({navigation}){
  const[tab,setTab]=useState('KEYS');
  const[claude,setClaude]=useState('');const[grok,setGrok]=useState('');const[openai,setOpenai]=useState('');const[elevenlabs,setElevenlabs]=useState('');const[meshy,setMeshy]=useState('');
  const[showKey,setShowKey]=useState({});
  const[promptPersona,setPromptPersona]=useState('jarvis');const[promptText,setPromptText]=useState('');
  const[usage,setUsage]=useState([]);const[saved,setSaved]=useState(false);
  const[crashes,setCrashes]=useState([]);
  const[googleConnected,setGoogleConnected]=useState(false);
  const[googleConnecting,setGoogleConnecting]=useState(false);
  const[memoryRecall,setMemoryRecall]=useState(true);
  const[deepConfirm,setDeepConfirm]=useState(true);
  const[tl,setTl]=useState({email:'',password:'',server:'',env:'demo'});
  const[tlBusy,setTlBusy]=useState(false);
  const[tlAccount,setTlAccount]=useState(null);
  const[ghToken,setGhToken]=useState('');
  const[ghBusy,setGhBusy]=useState(false);
  const[ghStatus,setGhStatus]=useState(null); // {ok,repo,error}
  const{personaPics,setPersonaPics}=useEmpireStore();
  const[request,response,promptAsync]=useGoogleAuth();
  useEffect(()=>{loadAll();},[]);
  useEffect(()=>{
    if(response?.type==='success'&&response.params?.code&&request){
      handleGoogleCode(response.params.code);
    }else if(response?.type==='success'&&response.authentication?.accessToken){
      // fallback: a provider that auto-exchanged or returned an implicit token
      handleGoogleSuccess({accessToken:response.authentication.accessToken,refreshToken:response.authentication.refreshToken||null,expiresAt:Date.now()+(Number(response.authentication.expiresIn)||3600)*1000});
    }else if(response?.type==='error'){
      setGoogleConnecting(false);
      Alert.alert('Google Sign-In Error',response.error?.message||response.params?.error_description||'Unknown error');
    }else if(response?.type==='cancel'||response?.type==='dismiss'){
      setGoogleConnecting(false);
    }
  },[response]);// eslint-disable-line react-hooks/exhaustive-deps
  async function loadAll(){
    const k=await loadKeys();if(k){setClaude(k.claude||'');setGrok(k.grok||'');setOpenai(k.openai||'');setElevenlabs(k.elevenlabs||'');setMeshy(k.meshy||'');}
    const u=await getApiUsage();setUsage(u);
    const p=await getAllPersonaPics();setPersonaPics(p);
    const g=await loadGoogleToken();setGoogleConnected(!!g?.accessToken);
    setMemoryRecall((await getSetting('memory_recall','1'))==='1');
    setDeepConfirm((await getSetting('deep_research_confirm','1'))==='1');
    const tc=await loadTradeCreds();if(tc)setTl({email:tc.email||'',password:tc.password||'',server:tc.server||'',env:tc.env||'demo'});
    const gt=await loadGitHubToken();if(gt){setGhToken(gt);ghVerify().then(setGhStatus);}
    setCrashes(await getCrashLog().catch(()=>[]));
  }
  async function connectTradeLocker(){
    if(!tl.email.trim()||!tl.password||!tl.server.trim()){Alert.alert('Required','Email, password and server are all required.');return;}
    setTlBusy(true);
    try{
      const creds={email:tl.email.trim(),password:tl.password,server:tl.server.trim(),env:tl.env};
      await saveTradeCreds(creds);
      const acct=await tlConnect();
      setTlAccount(acct);
      Alert.alert('Connected',`${acct.env.toUpperCase()} · ${acct.currency} ${Number(acct.balance||0).toLocaleString()} · acct ${acct.accountId}`);
    }catch(e){Alert.alert('TradeLocker',e.message);}
    finally{setTlBusy(false);}
  }
  async function disconnectTradeLocker(){
    await clearTradeCreds();tlReset();setTlAccount(null);setTl({email:'',password:'',server:'',env:'demo'});
    Alert.alert('Disconnected','TradeLocker login removed.');
  }
  async function connectGitHub(){
    if(!ghToken.trim()){Alert.alert('Required','Paste a GitHub token first.');return;}
    setGhBusy(true);
    try{
      await saveGitHubToken(ghToken.trim());
      const st=await ghVerify();
      setGhStatus(st);
      Alert.alert(st.ok?'Connected':'Not connected',st.ok?`Linked to ${st.repo}. JARVIS can now send build requests.`:st.error);
    }finally{setGhBusy(false);}
  }
  async function disconnectGitHub(){
    await clearGitHubToken();setGhToken('');setGhStatus(null);
    Alert.alert('Disconnected','GitHub token removed. JARVIS can no longer file build requests.');
  }
  async function toggleMemoryRecall(){const nv=!memoryRecall;setMemoryRecall(nv);await setSetting('memory_recall',nv?'1':'0');}
  async function toggleDeepConfirm(){const nv=!deepConfirm;setDeepConfirm(nv);await setSetting('deep_research_confirm',nv?'1':'0');}
  async function pickPersonaPic(id){
    try{
      const perm=await ImagePicker.requestMediaLibraryPermissionsAsync();
      if(perm.status!=='granted'){Alert.alert('Permission','Photo library access is required.');return;}
      const res=await ImagePicker.launchImageLibraryAsync({
        mediaTypes:ImagePicker.MediaTypeOptions.Images,
        allowsEditing:true,aspect:[1,1],quality:0.6,base64:true,
      });
      if(res.canceled||!res.assets?.[0]?.base64)return;
      const dataUri='data:image/jpeg;base64,'+res.assets[0].base64;
      await savePersonaPic(id,dataUri);
      const p=await getAllPersonaPics();setPersonaPics(p);
    }catch(e){Alert.alert('Error',e.message);}
  }
  function clearPersonaPic(id){
    Alert.alert('Remove photo','Remove this persona photo?',[
      {text:'Cancel'},
      {text:'Remove',style:'destructive',onPress:async()=>{await savePersonaPic(id,'');const p=await getAllPersonaPics();setPersonaPics(p);}},
    ]);
  }
  async function handleGoogleCode(code){
    try{
      await handleGoogleSuccess(await exchangeGoogleCode(code,request));
    }catch(e){
      setGoogleConnecting(false);
      Alert.alert('Google Sign-In Error',e.message);
    }
  }
  async function handleGoogleSuccess(tok){
    await saveGoogleToken(tok);
    setGoogleConnected(true);
    setGoogleConnecting(false);
    Alert.alert('Connected',tok?.refreshToken
      ?'Google account connected. The token now refreshes itself in the background.'
      :'Google account connected — but no refresh token was issued, so it will expire in ~1 hour. Disconnect and reconnect once to enable auto-refresh.');
  }
  async function connectGoogle(){
    setGoogleConnecting(true);
    try{await promptAsync();}catch(e){setGoogleConnecting(false);Alert.alert('Error',e.message);}
  }
  async function disconnectGoogle(){
    await revokeGoogle();
    await clearGoogleToken();
    setGoogleConnected(false);
    Alert.alert('Disconnected','Google account disconnected.');
  }
  async function saveApiKeys(){
    if(!claude.trim()){Alert.alert('Required','Claude API key is required.');return;}
    await saveKeys({claude:claude.trim(),grok:grok.trim(),openai:openai.trim(),elevenlabs:elevenlabs.trim(),meshy:meshy.trim()});
    setSaved(true);setTimeout(()=>setSaved(false),2000);
  }
  async function loadPrompt(personaId){
    setPromptPersona(personaId);
    const custom=await getCustomPrompt(personaId);
    if(custom)setPromptText(custom);
    else setPromptText(getPersona(personaId).system||'');
  }
  async function savePrompt(){await saveCustomPrompt(promptPersona,promptText);Alert.alert('Saved',`${getPersona(promptPersona).name} prompt updated.`);}
  async function resetPrompt(){setPromptText(getPersona(promptPersona).system||'');await saveCustomPrompt(promptPersona,getPersona(promptPersona).system||'');Alert.alert('Reset','Prompt restored to default.');}
  const totalUsage=usage.reduce((acc,u)=>({...acc,[u.provider]:{in:(acc[u.provider]?.in||0)+u.tokens_in,out:(acc[u.provider]?.out||0)+u.tokens_out}}),{});
  return(
    <SafeAreaView style={s.c} edges={['top','bottom']}>
      <View style={s.hdr}>
        {navigation.canGoBack()&&<TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity>}
        <Text style={s.title}>SETTINGS</Text>
        <View style={{width:30}}/>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabsScroll} contentContainerStyle={s.tabs}>
        {TABS.map(t=>(<TouchableOpacity key={t} style={[s.tab,tab===t&&s.tabA]} onPress={()=>setTab(t)}><Text style={[s.tabT,tab===t&&s.tabTA]}>{t}</Text></TouchableOpacity>))}
      </ScrollView>
      <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}>
        <ScrollView contentContainerStyle={s.content}>
          {tab==='KEYS'&&<View>
            <Text style={s.secTitle}>API KEYS</Text>
            <Text style={s.secSub}>Stored securely on device only. Never transmitted except to respective API.</Text>
            {[
              ['ANTHROPIC (CLAUDE)','Required · Jarvis, Stephanie, Atlas, Haven, Aisha, Abraham, Batman',claude,setClaude,'sk-ant-...'],
              ['XAI (GROK)','Required · Ara, Rogue',grok,setGrok,'xai-...'],
              ['OPENAI','Optional · Selene',openai,setOpenai,'sk-...'],
              ['ELEVENLABS','Optional · Voice synthesis',elevenlabs,setElevenlabs,'...'],
              ['MESHY','Optional · 3D model generation for the HUD diagram card',meshy,setMeshy,'msy_...']
            ].map(([label,sub,val,setter,ph])=>(
              <View key={label} style={s.keyField}>
                <View style={s.keyHdr}>
                  <Text style={s.keyLabel}>{label}</Text>
                  <TouchableOpacity onPress={()=>setShowKey(prev=>({...prev,[label]:!prev[label]}))}>
                    <Text style={s.showHide}>{showKey[label]?'HIDE':'SHOW'}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={s.keySub}>{sub}</Text>
                <TextInput style={s.keyInput} value={val} onChangeText={setter} placeholder={ph} placeholderTextColor="#1A1A1A" secureTextEntry={!showKey[label]} autoCapitalize="none" autoCorrect={false}/>
              </View>
            ))}
            <TouchableOpacity style={s.saveBtn} onPress={saveApiKeys}><Text style={s.saveBtnT}>{saved?'✓ SAVED':'SAVE KEYS'}</Text></TouchableOpacity>
          </View>}
          {tab==='GOOGLE'&&<View>
            <Text style={s.secTitle}>GOOGLE ACCOUNT</Text>
            <Text style={s.secSub}>Connects Drive, Gmail, Calendar, and Tasks. Required for cross-device memory sync and email/calendar access.</Text>
            <View style={s.googleStatusCard}>
              <View style={s.googleStatusRow}>
                <View style={[s.googleDot,googleConnected&&s.googleDotOn]}/>
                <Text style={s.googleStatusText}>{googleConnected?'CONNECTED':'NOT CONNECTED'}</Text>
              </View>
              {googleConnected?(
                <TouchableOpacity style={[s.saveBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333',marginTop:16}]} onPress={disconnectGoogle}>
                  <Text style={[s.saveBtnT,{color:'#E05555'}]}>DISCONNECT</Text>
                </TouchableOpacity>
              ):(
                <TouchableOpacity style={[s.saveBtn,{marginTop:16}]} onPress={connectGoogle} disabled={!request||googleConnecting}>
                  <Text style={s.saveBtnT}>{googleConnecting?'CONNECTING...':'CONNECT GOOGLE'}</Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={s.googleNote}>The access token is refreshed automatically in the background using a stored refresh token — no need to reconnect unless you revoke access from your Google account.</Text>
          </View>}
          {tab==='TRADING'&&<View>
            <Text style={s.secTitle}>TRADELOCKER</Text>
            <Text style={s.secSub}>Atlas trades XAUUSD through this login while the app is open. Max 0.01 lot per order. Demo account recommended until proven. Stored securely on device.</Text>
            <View style={s.tlEnvRow}>
              {['demo','live'].map(e=>(
                <TouchableOpacity key={e} style={[s.tlEnvBtn,tl.env===e&&s.tlEnvBtnA]} onPress={()=>setTl(v=>({...v,env:e}))}>
                  <Text style={[s.tlEnvT,tl.env===e&&s.tlEnvTA]}>{e.toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {[['Email','email',false,'you@example.com'],['Password','password',true,'••••••••'],['Server','server',false,'e.g. OSP-DEMO']].map(([label,key,secure,ph])=>(
              <View key={key} style={s.keyField}>
                <Text style={s.keyLabel}>{label.toUpperCase()}</Text>
                <TextInput style={s.keyInput} value={tl[key]} onChangeText={t=>setTl(v=>({...v,[key]:t}))} placeholder={ph} placeholderTextColor="#1A1A1A" secureTextEntry={secure} autoCapitalize="none" autoCorrect={false}/>
              </View>
            ))}
            <TouchableOpacity style={s.saveBtn} onPress={connectTradeLocker} disabled={tlBusy}>
              <Text style={s.saveBtnT}>{tlBusy?'CONNECTING…':'CONNECT'}</Text>
            </TouchableOpacity>
            {tlAccount&&<View style={s.tlAcctCard}>
              <Text style={s.tlAcctLine}>{tlAccount.env.toUpperCase()} · acct {tlAccount.accountId}</Text>
              <Text style={s.tlAcctBal}>{tlAccount.currency} {Number(tlAccount.balance||0).toLocaleString()}</Text>
            </View>}
            <TouchableOpacity style={[s.saveBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333',marginTop:10}]} onPress={disconnectTradeLocker}>
              <Text style={[s.saveBtnT,{color:'#E05555'}]}>DISCONNECT</Text>
            </TouchableOpacity>
          </View>}
          {tab==='DEV'&&<View>
            <Text style={s.secTitle}>BUILD PIPELINE</Text>
            <Text style={s.secSub}>JARVIS files what you ask for as a GitHub issue; Claude Code implements it, opens a pull request, and JARVIS relays the questions and tells you when it's shipped. Runs only while the app is open. Every run bills your Anthropic key.</Text>
            {ghStatus&&<View style={[s.tlAcctCard,{marginTop:0,marginBottom:16,borderColor:ghStatus.ok?'#2c4a38':'#4a2c2c'}]}>
              <Text style={[s.tlAcctLine,{color:ghStatus.ok?'#5FA779':'#C7614B'}]}>{ghStatus.ok?`CONNECTED · ${ghStatus.repo}`:`NOT CONNECTED · ${ghStatus.error}`}</Text>
            </View>}
            <View style={s.keyField}>
              <Text style={s.keyLabel}>GITHUB TOKEN</Text>
              <TextInput style={s.keyInput} value={ghToken} onChangeText={setGhToken} placeholder="github_pat_…" placeholderTextColor="#1A1A1A" secureTextEntry autoCapitalize="none" autoCorrect={false}/>
            </View>
            <TouchableOpacity style={s.saveBtn} onPress={connectGitHub} disabled={ghBusy}>
              <Text style={s.saveBtnT}>{ghBusy?'CHECKING…':'CONNECT'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.saveBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333',marginTop:10}]} onPress={disconnectGitHub}>
              <Text style={[s.saveBtnT,{color:'#E05555'}]}>DISCONNECT</Text>
            </TouchableOpacity>
            <Text style={[s.secSub,{marginTop:20,marginBottom:0}]}>ONE-TIME GITHUB SETUP{'\n'}1 · Repo → Settings → Secrets and variables → Actions → add ANTHROPIC_API_KEY (sk-ant-…). Without it Claude Code can't run.{'\n'}2 · Repo → Settings → Actions → General → enable "Allow GitHub Actions to create and approve pull requests."{'\n'}3 · github.com/settings/tokens → fine-grained token, this repo only, with Contents + Issues + Pull requests set to Read and write. Paste it above.</Text>
          </View>}
          {tab==='AI'&&<View>
            <Text style={s.secTitle}>AI BEHAVIOR</Text>
            <Text style={s.secSub}>Controls for the memory and research subsystems. Calls bill to your own API keys.</Text>
            <TouchableOpacity style={s.toggleRow} onPress={toggleMemoryRecall} activeOpacity={0.7}>
              <View style={{flex:1,paddingRight:12}}>
                <Text style={s.toggleLabel}>MEMORY RECALL</Text>
                <Text style={s.toggleSub}>Lets any persona ask Claude to reason over its full stored memory when it needs deep recall. One extra Claude call on those turns only.</Text>
              </View>
              <View style={[s.switch,memoryRecall&&s.switchOn]}><View style={[s.knob,memoryRecall&&s.knobOn]}/></View>
            </TouchableOpacity>
            <TouchableOpacity style={s.toggleRow} onPress={toggleDeepConfirm} activeOpacity={0.7}>
              <View style={{flex:1,paddingRight:12}}>
                <Text style={s.toggleLabel}>CONFIRM DEEP RESEARCH</Text>
                <Text style={s.toggleSub}>Ask before every Deep Research run (OpenAI, minutes long, dollars per run).</Text>
              </View>
              <View style={[s.switch,deepConfirm&&s.switchOn]}><View style={[s.knob,deepConfirm&&s.knobOn]}/></View>
            </TouchableOpacity>
            <View style={s.infoRow}>
              <Text style={s.toggleLabel}>MEMORY</Text>
              <Text style={s.toggleSub}>Every persona keeps its full memory loaded and active on every conversation, direct or group. No switch — always on.</Text>
            </View>
          </View>}
          {tab==='PROFILES'&&<View>
            <Text style={s.secTitle}>PERSONA PROFILES</Text>
            <Text style={s.secSub}>Used on the Command screen and, for the persona visualization, inside the glow.</Text>
            <View style={s.picsGrid}>
              {PERSONA_LIST.map(p=>{
                const pic=personaPics?.[p.id];
                return(
                  <TouchableOpacity key={p.id} style={s.picItem} onPress={()=>pickPersonaPic(p.id)} onLongPress={()=>pic&&clearPersonaPic(p.id)}>
                    <View style={[s.picAvatar,{borderColor:p.color}]}>
                      {pic?<Image source={{uri:pic}} style={{width:'100%',height:'100%'}}/>:<Text style={[s.picInitial,{color:p.color}]}>{p.icon}</Text>}
                    </View>
                    <Text style={[s.picName,{color:p.color}]}>{p.name.replace(/\./g,'').substring(0,6)}</Text>
                    <Text style={s.picRole} numberOfLines={1}>{p.role}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>}
          {tab==='PROMPTS'&&<View>
            <Text style={s.secTitle}>CUSTOM PROMPTS</Text>
            <Text style={s.secSub}>Override any persona system prompt.</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom:12}} contentContainerStyle={{gap:8,paddingVertical:4}}>
              {PERSONA_LIST.map(p=>(
                <TouchableOpacity key={p.id} style={[s.personaChip,promptPersona===p.id&&{borderColor:p.color,backgroundColor:p.color+'11'}]} onPress={()=>loadPrompt(p.id)}>
                  <Text style={[s.personaChipT,promptPersona===p.id&&{color:p.color}]}>{p.name.replace(/\./g,'').substring(0,4)}</Text>
                </TouchableOpacity>
              ))}
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
            {Object.entries(totalUsage).map(([provider,u])=>(
              <View key={provider} style={s.usageCard}>
                <Text style={s.usageProvider}>{provider.toUpperCase()}</Text>
                <View style={s.usageRow}><Text style={s.usageLabel}>Input tokens</Text><Text style={s.usageVal}>{u.in.toLocaleString()}</Text></View>
                <View style={s.usageRow}><Text style={s.usageLabel}>Output tokens</Text><Text style={s.usageVal}>{u.out.toLocaleString()}</Text></View>
              </View>
            ))}
            {Object.keys(totalUsage).length===0&&<Text style={s.empty}>No usage recorded yet.</Text>}
          </View>}
          {tab==='DIAGNOSTICS'&&<View>
            <Text style={s.secTitle}>DIAGNOSTICS</Text>
            <Text style={s.secSub}>The last {crashes.length} crash{crashes.length===1?'':'es'} captured on this device. Share these if the app is misbehaving.</Text>
            {crashes.length>0&&<TouchableOpacity style={[s.saveBtn,{marginTop:0,marginBottom:16,backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={async()=>{await clearCrashLog();setCrashes([]);}}>
              <Text style={[s.saveBtnT,{color:'#E05555'}]}>CLEAR LOG</Text>
            </TouchableOpacity>}
            {crashes.length===0&&<Text style={s.empty}>No crashes logged. Good sign.</Text>}
            {crashes.map((c,i)=>(
              <View key={i} style={s.usageCard}>
                <Text style={s.crashHead}>{new Date(c.ts).toLocaleString()} · {c.source}</Text>
                <Text style={s.crashMsg}>{c.message}</Text>
                {!!c.stack&&<Text style={s.crashStack} numberOfLines={6}>{c.stack}</Text>}
              </View>
            ))}
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
  tabsScroll:{borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  tabs:{flexDirection:'row',paddingHorizontal:12,paddingTop:8,gap:6},
  tab:{paddingHorizontal:14,paddingVertical:6,borderRadius:4,borderWidth:1,borderColor:'#111',marginBottom:8},
  tabA:{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'},tabT:{fontFamily:'monospace',fontSize:9,color:'#333',letterSpacing:1},tabTA:{color:'#E8C98A'},
  content:{padding:18,paddingBottom:40},
  tlEnvRow:{flexDirection:'row',gap:8,marginBottom:16},
  tlEnvBtn:{flex:1,paddingVertical:8,borderRadius:6,borderWidth:1,borderColor:'#1A1A1A',alignItems:'center'},
  tlEnvBtnA:{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'},
  tlEnvT:{fontFamily:'monospace',fontSize:9,color:'#444',letterSpacing:2},tlEnvTA:{color:'#E8C98A'},
  tlAcctCard:{marginTop:14,borderWidth:1,borderColor:'#1F1B14',borderRadius:8,padding:14},
  tlAcctLine:{fontFamily:'monospace',fontSize:8,color:'#555',letterSpacing:2,marginBottom:4},
  tlAcctBal:{fontFamily:'monospace',fontSize:16,color:'#5FA779',fontWeight:'700'},
  toggleRow:{flexDirection:'row',alignItems:'center',paddingVertical:14,borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  infoRow:{paddingVertical:14,borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  crashHead:{fontFamily:'monospace',fontSize:8,color:'#E8C98A',letterSpacing:1,marginBottom:6},
  crashMsg:{fontFamily:'monospace',fontSize:10,color:'#CCC',lineHeight:15,marginBottom:6},
  crashStack:{fontFamily:'monospace',fontSize:7,color:'#555',lineHeight:11},
  toggleLabel:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',letterSpacing:2,marginBottom:4},
  toggleSub:{fontFamily:'monospace',fontSize:8,color:'#444',lineHeight:13},
  switch:{width:40,height:22,borderRadius:11,backgroundColor:'#1A1A1A',borderWidth:1,borderColor:'#2A2A2A',padding:2,justifyContent:'center'},
  switchOn:{backgroundColor:'#E8C98A33',borderColor:'#E8C98A'},
  knob:{width:16,height:16,borderRadius:8,backgroundColor:'#444'},
  knobOn:{backgroundColor:'#E8C98A',alignSelf:'flex-end'},
  secTitle:{fontFamily:'monospace',fontSize:11,color:'#E8C98A',letterSpacing:3,marginBottom:4},
  secSub:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1,marginBottom:18,lineHeight:14},
  keyField:{marginBottom:18},
  keyHdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:3},
  keyLabel:{fontFamily:'monospace',fontSize:9,color:'#666',letterSpacing:2},
  showHide:{fontFamily:'monospace',fontSize:8,color:'#333'},
  keySub:{fontFamily:'monospace',fontSize:7,color:'#222',letterSpacing:1,marginBottom:6},
  keyInput:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,paddingHorizontal:12,paddingVertical:10,color:'#CCC',fontSize:12,fontFamily:'monospace'},
  saveBtn:{backgroundColor:'#E8C98A',padding:14,borderRadius:6,alignItems:'center',marginTop:20},
  saveBtnT:{fontFamily:'monospace',fontWeight:'700',color:'#000',fontSize:11,letterSpacing:3},
  googleStatusCard:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:8,padding:18},
  googleStatusRow:{flexDirection:'row',alignItems:'center',gap:8},
  googleDot:{width:8,height:8,borderRadius:4,backgroundColor:'#E05555'},
  googleDotOn:{backgroundColor:'#4CAF50'},
  googleStatusText:{fontFamily:'monospace',fontSize:10,color:'#888',letterSpacing:2},
  googleNote:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1,marginTop:16,lineHeight:14},
  picsGrid:{flexDirection:'row',flexWrap:'wrap',gap:16},
  picItem:{width:'28%',alignItems:'center'},
  picAvatar:{width:56,height:56,borderRadius:28,borderWidth:2,alignItems:'center',justifyContent:'center',marginBottom:6,overflow:'hidden'},
  picInitial:{fontFamily:'monospace',fontSize:16,fontWeight:'700'},
  picName:{fontFamily:'monospace',fontSize:7,letterSpacing:1,textAlign:'center'},
  picRole:{fontFamily:'monospace',fontSize:6,color:'#222',textAlign:'center',marginTop:2},
  personaChip:{paddingHorizontal:12,paddingVertical:6,borderRadius:4,borderWidth:1,borderColor:'#1A1A1A'},
  personaChipT:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1},
  editingLabel:{fontFamily:'monospace',fontSize:9,color:'#555',letterSpacing:2,marginBottom:10},
  promptInput:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,padding:14,color:'#CCC',fontSize:12,minHeight:200,textAlignVertical:'top'},
  usageCard:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,padding:16,marginBottom:12},
  usageProvider:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',letterSpacing:3,marginBottom:10},
  usageRow:{flexDirection:'row',justifyContent:'space-between',paddingVertical:4},
  usageLabel:{fontFamily:'monospace',fontSize:9,color:'#444'},
  usageVal:{fontFamily:'monospace',fontSize:9,color:'#E8C98A'},
  empty:{fontFamily:'monospace',fontSize:10,color:'#222',textAlign:'center',marginTop:40,letterSpacing:1},
});
