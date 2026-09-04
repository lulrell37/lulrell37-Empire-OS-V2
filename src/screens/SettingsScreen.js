import React,{useState,useEffect}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,ScrollView,Alert,KeyboardAvoidingView,Platform,Image}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import*as ImagePicker from 'expo-image-picker';
import{saveKeys,loadKeys,saveGoogleToken,loadGoogleToken,clearGoogleToken,saveTradeCreds,loadTradeCreds,clearTradeCreds,saveGitHubToken,loadGitHubToken,clearGitHubToken,saveBackend,loadBackend,clearBackend}from '../services/keyStore';
import{runSync,pingBackend,initSyncStatus}from '../services/sync';
import{registerPushToken,unregisterPushToken,sendTestPush}from '../services/push';
import{tlConnect,tlReset}from '../services/tradeLocker';
import{refreshAutoTrader}from '../services/autoTrader';
import{refreshAutoScout}from '../services/autoScout';
import{resetWeather}from '../services/weather';
import{ghVerify}from '../services/buildAgent';
import{saveCustomPrompt,getCustomPrompt,getApiUsage,getAllPersonaPics,savePersonaPic,getSetting,setSetting}from '../services/database';
import{getCrashLog,clearCrashLog}from '../services/crashLog';
import{PERSONA_LIST,getPersona}from '../personas/personas';
import{useGoogleAuth,exchangeGoogleCode,revokeGoogle}from '../services/googleAuth';
import useEmpireStore from '../store/useEmpireStore';
const TABS=['KEYS','GOOGLE','TRADING','OUTREACH','DEV','BACKEND','AI','PROFILES','PROMPTS','USAGE','DIAGNOSTICS'];
export default function SettingsScreen({navigation}){
  const[tab,setTab]=useState('KEYS');
  const[claude,setClaude]=useState('');const[grok,setGrok]=useState('');const[openai,setOpenai]=useState('');const[gemini,setGemini]=useState('');const[elevenlabs,setElevenlabs]=useState('');const[meshy,setMeshy]=useState('');
  const[showKey,setShowKey]=useState({});
  const[promptPersona,setPromptPersona]=useState('jarvis');const[promptText,setPromptText]=useState('');
  const[usage,setUsage]=useState([]);const[saved,setSaved]=useState(false);
  const[crashes,setCrashes]=useState([]);
  const[googleConnected,setGoogleConnected]=useState(false);
  const[googleConnecting,setGoogleConnecting]=useState(false);
  const[memoryRecall,setMemoryRecall]=useState(true);
  const[deepConfirm,setDeepConfirm]=useState(true);
  const[deepModel,setDeepModel]=useState('auto');
  const[tl,setTl]=useState({email:'',password:'',server:'',env:'demo'});
  const[tlBusy,setTlBusy]=useState(false);
  const[tlAccount,setTlAccount]=useState(null);
  const[autoTrade,setAutoTrade]=useState(false);
  const[autoSyms,setAutoSyms]=useState('XAUUSD, EURUSD, GBPJPY, BTCUSD');
  const[autoEvery,setAutoEvery]=useState('5');
  const[weatherPlace,setWeatherPlace]=useState('Waldorf, MD');
  const[inboundSheet,setInboundSheet]=useState('');
  const[autoScout,setAutoScout]=useState(false);
  const[scoutEvery,setScoutEvery]=useState('30');
  const[scoutLeads,setScoutLeads]=useState('20');
  const[scoutEmails,setScoutEmails]=useState('20');
  const[ghToken,setGhToken]=useState('');
  const[ghBusy,setGhBusy]=useState(false);
  const[ghStatus,setGhStatus]=useState(null); // {ok,repo,error}
  const[beUrl,setBeUrl]=useState('');const[beToken,setBeToken]=useState('');
  const[beBusy,setBeBusy]=useState(false);
  const[beConfigured,setBeConfigured]=useState(false);
  const[beSync,setBeSync]=useState({lastSync:0,error:null,running:false});
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
    const k=await loadKeys();if(k){setClaude(k.claude||'');setGrok(k.grok||'');setOpenai(k.openai||'');setGemini(k.gemini||'');setElevenlabs(k.elevenlabs||'');setMeshy(k.meshy||'');}
    const u=await getApiUsage();setUsage(u);
    const p=await getAllPersonaPics();setPersonaPics(p);
    const g=await loadGoogleToken();setGoogleConnected(!!g?.accessToken);
    setMemoryRecall((await getSetting('memory_recall','1'))==='1');
    setDeepConfirm((await getSetting('deep_research_confirm','1'))==='1');
    setDeepModel(await getSetting('deep_research_model','auto'));
    const tc=await loadTradeCreds();if(tc)setTl({email:tc.email||'',password:tc.password||'',server:tc.server||'',env:tc.env||'demo'});
    setAutoTrade((await getSetting('auto_trade','0'))==='1');
    setAutoSyms(await getSetting('auto_trade_symbols','XAUUSD, EURUSD, GBPJPY, BTCUSD'));
    setAutoEvery(await getSetting('auto_trade_interval_min','5'));
    setWeatherPlace(await getSetting('weather_place','Waldorf, MD'));
    setInboundSheet(await getSetting('inbound_sheet_id',''));
    setAutoScout((await getSetting('auto_scout','0'))==='1');
    setScoutEvery(await getSetting('auto_scout_interval_min','30'));
    setScoutLeads(await getSetting('auto_scout_daily_leads','20'));
    setScoutEmails(await getSetting('auto_scout_daily_emails','20'));
    const gt=await loadGitHubToken();if(gt){setGhToken(gt);ghVerify().then(setGhStatus);}
    const be=await loadBackend();if(be){setBeUrl(be.url);setBeToken(be.token);setBeConfigured(true);}
    const st=await initSyncStatus().catch(()=>null);if(st)setBeSync({lastSync:st.lastSync,error:st.error,running:st.running});
    setCrashes(await getCrashLog().catch(()=>[]));
  }
  async function connectBackend(){
    if(!beUrl.trim()||!beToken.trim()){Alert.alert('Required','Server URL and sync token are both required.');return;}
    setBeBusy(true);
    try{
      await pingBackend(beUrl);
      const saved=await saveBackend({url:beUrl,token:beToken});
      setBeUrl(saved.url);setBeConfigured(true);
      const st=await runSync({full:true});
      setBeSync({lastSync:st.lastSync,error:st.error,running:st.running});
      registerPushToken().catch(()=>{});
      Alert.alert(st.error?'Connected · first sync failed':'Connected',st.error||'Backend linked. This device now syncs, routes AI calls through it, and gets scheduled nudges.');
    }catch(e){Alert.alert('Backend',e.message);}
    finally{setBeBusy(false);}
  }
  async function testPush(){
    setBeBusy(true);
    try{await registerPushToken();const r=await sendTestPush();Alert.alert('Test sent',`Pushed to ${r.devices} device${r.devices===1?'':'s'}. It should arrive in a few seconds.`);}
    catch(e){Alert.alert('Test push',e.message);}
    finally{setBeBusy(false);}
  }
  async function syncNow(){
    setBeBusy(true);
    try{const st=await runSync();setBeSync({lastSync:st.lastSync,error:st.error,running:st.running});if(st.error)Alert.alert('Sync failed',st.error);}
    finally{setBeBusy(false);}
  }
  async function fullResync(){
    setBeBusy(true);
    try{const st=await runSync({full:true});setBeSync({lastSync:st.lastSync,error:st.error,running:st.running});Alert.alert(st.error?'Resync failed':'Resync complete',st.error||'Re-pulled the full dataset from the backend.');}
    finally{setBeBusy(false);}
  }
  async function disconnectBackend(){
    await unregisterPushToken().catch(()=>{});
    await clearBackend();setBeConfigured(false);setBeToken('');setBeSync({lastSync:0,error:null,running:false});
    Alert.alert('Disconnected','Backend removed. This device is fully local again.');
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
  async function toggleAutoTrade(){
    const nv=!autoTrade;
    if(nv&&tl.env!=='demo'){Alert.alert('Demo only','Auto-trade runs on a demo account only. Switch TradeLocker to DEMO first.');return;}
    setAutoTrade(nv);
    await setSetting('auto_trade',nv?'1':'0');
    await refreshAutoTrader().catch(()=>{});
  }
  async function saveAutoSyms(){await setSetting('auto_trade_symbols',autoSyms.trim()||'XAUUSD');await refreshAutoTrader().catch(()=>{});}
  async function saveWeatherPlace(){await setSetting('weather_place',weatherPlace.trim()||'Waldorf, MD');await setSetting('weather_geo','');resetWeather();}
  async function saveInboundSheet(){
    // accept a full Sheets URL or a bare id
    const m=inboundSheet.trim().match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const id=m?m[1]:inboundSheet.trim();
    setInboundSheet(id);
    await setSetting('inbound_sheet_id',id);
  }
  async function saveAutoEvery(){
    const n=Math.max(1,parseInt(autoEvery,10)||5);
    setAutoEvery(String(n));await setSetting('auto_trade_interval_min',String(n));await refreshAutoTrader().catch(()=>{});
  }
  async function toggleAutoScout(){
    const nv=!autoScout;
    setAutoScout(nv);
    await setSetting('auto_scout',nv?'1':'0');
    await refreshAutoScout().catch(()=>{});
  }
  async function saveScoutNum(key,val,setter,def,min){
    const n=Math.max(min,parseInt(val,10)||def);
    setter(String(n));await setSetting(key,String(n));await refreshAutoScout().catch(()=>{});
  }
  async function disconnectTradeLocker(){
    await clearTradeCreds();tlReset();setTlAccount(null);setTl({email:'',password:'',server:'',env:'demo'});
    setAutoTrade(false);await setSetting('auto_trade','0');await refreshAutoTrader().catch(()=>{});
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
  async function cycleDeepModel(){
    const order=['auto','o3-deep-research','o4-mini-deep-research'];
    const nv=order[(order.indexOf(deepModel)+1)%order.length];
    setDeepModel(nv);await setSetting('deep_research_model',nv);
  }
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
    await saveKeys({claude:claude.trim(),grok:grok.trim(),openai:openai.trim(),gemini:gemini.trim(),elevenlabs:elevenlabs.trim(),meshy:meshy.trim()});
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
              ['ANTHROPIC (CLAUDE)','Required · Jarvis, Stephanie, Atlas, Talon, Haven, Aisha, Abraham, Batman',claude,setClaude,'sk-ant-...'],
              ['XAI (GROK)','Required · Ara, Rogue',grok,setGrok,'xai-...'],
              ['OPENAI','Optional · Selene',openai,setOpenai,'sk-...'],
              ['GOOGLE (GEMINI)','Required · Nova',gemini,setGemini,'AIza...'],
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

            <Text style={[s.secTitle,{marginTop:28}]}>HUD AGENDA</Text>
            <Text style={s.secSub}>The AGENDA panel shows weather, your next calendar events, unread inbox, and tasks. Weather uses Open-Meteo (no key needed).</Text>
            <View style={s.keyField}>
              <Text style={s.keyLabel}>WEATHER LOCATION</Text>
              <TextInput style={s.keyInput} value={weatherPlace} onChangeText={setWeatherPlace} onBlur={saveWeatherPlace} placeholder="Waldorf, MD" placeholderTextColor="#1A1A1A" autoCorrect={false}/>
            </View>

            <Text style={[s.secTitle,{marginTop:28}]}>INBOUND LEADS</Text>
            <Text style={s.secSub}>S.C.O.U.T. pulls new website enquiries straight into her pipeline while the app is open. Make a Google Form for tarellbempire.com, link it to a responses sheet, and paste that sheet's link (or ID) here. New rows become leads at the "inbound" stage. Needs Google connected above.</Text>
            <View style={s.keyField}>
              <Text style={s.keyLabel}>FORM RESPONSES SHEET</Text>
              <TextInput style={s.keyInput} value={inboundSheet} onChangeText={setInboundSheet} onBlur={saveInboundSheet} placeholder="docs.google.com/spreadsheets/d/…  or the ID" placeholderTextColor="#1A1A1A" autoCapitalize="none" autoCorrect={false}/>
            </View>
          </View>}
          {tab==='TRADING'&&<View>
            <Text style={s.secTitle}>TRADELOCKER</Text>
            <Text style={s.secSub}>T.A.L.O.N. trades through this login while the app is open. Max 0.01 lot per order. Demo account recommended until proven. Stored securely on device.</Text>
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

            <Text style={[s.secTitle,{marginTop:28}]}>T.A.L.O.N. AUTO-TRADE</Text>
            <Text style={s.secSub}>Lets T.A.L.O.N. open and close 0.01-lot trades on its own while the app is open — no confirmation. DEMO ACCOUNT ONLY; the loop refuses to touch a live account. No caps or loss limit — this is an experiment to see how it does.</Text>
            <TouchableOpacity style={s.toggleRow} onPress={toggleAutoTrade} activeOpacity={0.7}>
              <View style={{flex:1,paddingRight:12}}>
                <Text style={s.toggleLabel}>AUTONOMOUS TRADING</Text>
                <Text style={s.toggleSub}>{autoTrade?`On — T.A.L.O.N. is watching ${autoSyms} every ${autoEvery} min.`:'Off — T.A.L.O.N. only trades when you confirm a proposal.'}</Text>
              </View>
              <View style={[s.switch,autoTrade&&s.switchOn]}><View style={[s.knob,autoTrade&&s.knobOn]}/></View>
            </TouchableOpacity>
            <View style={s.keyField}>
              <Text style={s.keyLabel}>WATCHED SYMBOLS</Text>
              <TextInput style={s.keyInput} value={autoSyms} onChangeText={setAutoSyms} onBlur={saveAutoSyms} placeholder="XAUUSD, EURUSD, GBPJPY" placeholderTextColor="#1A1A1A" autoCapitalize="characters" autoCorrect={false}/>
            </View>
            <View style={s.keyField}>
              <Text style={s.keyLabel}>CHECK EVERY (MINUTES)</Text>
              <TextInput style={s.keyInput} value={String(autoEvery)} onChangeText={setAutoEvery} onBlur={saveAutoEvery} placeholder="5" placeholderTextColor="#1A1A1A" keyboardType="number-pad"/>
            </View>
          </View>}
          {tab==='OUTREACH'&&<View>
            <Text style={s.secTitle}>S.C.O.U.T. AUTO-SCOUT</Text>
            <Text style={s.secSub}>Lets S.C.O.U.T. prospect the entire US and send cold outreach on her own while the app is open — no confirmation on any email. Emails go from your connected Gmail; sustained cold sending from a personal account can get it throttled or suspended. Every cycle bills your Claude key. Needs a Claude key and Google connected. Nothing runs while the app is closed.</Text>
            <TouchableOpacity style={s.toggleRow} onPress={toggleAutoScout} activeOpacity={0.7}>
              <View style={{flex:1,paddingRight:12}}>
                <Text style={s.toggleLabel}>AUTONOMOUS SCOUTING</Text>
                <Text style={s.toggleSub}>{autoScout?`On — prospecting every ${scoutEvery} min, up to ${scoutLeads} new leads and ${scoutEmails} emails a day.`:'Off — S.C.O.U.T. only scouts and emails when you ask.'}</Text>
              </View>
              <View style={[s.switch,autoScout&&s.switchOn]}><View style={[s.knob,autoScout&&s.knobOn]}/></View>
            </TouchableOpacity>
            <View style={s.keyField}>
              <Text style={s.keyLabel}>SCAN EVERY (MINUTES)</Text>
              <TextInput style={s.keyInput} value={String(scoutEvery)} onChangeText={setScoutEvery} onBlur={()=>saveScoutNum('auto_scout_interval_min',scoutEvery,setScoutEvery,30,1)} placeholder="30" placeholderTextColor="#1A1A1A" keyboardType="number-pad"/>
            </View>
            <View style={s.keyField}>
              <Text style={s.keyLabel}>NEW LEADS PER DAY (MAX)</Text>
              <TextInput style={s.keyInput} value={String(scoutLeads)} onChangeText={setScoutLeads} onBlur={()=>saveScoutNum('auto_scout_daily_leads',scoutLeads,setScoutLeads,20,1)} placeholder="20" placeholderTextColor="#1A1A1A" keyboardType="number-pad"/>
            </View>
            <View style={s.keyField}>
              <Text style={s.keyLabel}>AUTO-SENT EMAILS PER DAY (MAX)</Text>
              <TextInput style={s.keyInput} value={String(scoutEmails)} onChangeText={setScoutEmails} onBlur={()=>saveScoutNum('auto_scout_daily_emails',scoutEmails,setScoutEmails,20,0)} placeholder="20" placeholderTextColor="#1A1A1A" keyboardType="number-pad"/>
            </View>
            <Text style={[s.secSub,{marginTop:16,marginBottom:0}]}>Set AUTO-SENT EMAILS to 0 to have her only build and qualify the pipeline — no email leaves on its own; you send each one from the Command screen.</Text>
          </View>}
          {tab==='DEV'&&<View>
            <Text style={s.secTitle}>BUILD PIPELINE</Text>
            <Text style={s.secSub}>JARVIS files app changes as GitHub issues; Claude Code implements them, opens a pull request, and JARVIS relays questions and tells you when it's shipped. A.R.A. uses the same pipeline for client projects — each gets its own repo, created from client-project-template. Runs only while the app is open. Every run bills your Anthropic key.</Text>
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
            <Text style={[s.secSub,{marginTop:20,marginBottom:0}]}>ONE-TIME GITHUB SETUP{'\n'}1 · github.com/settings/tokens → generate a CLASSIC token with the "repo" and "workflow" scopes (a fine-grained "single repo" token can't create the client-project repos). Paste it above and tap CONNECT.{'\n'}2 · This Empire OS repo → Settings → Secrets and variables → Actions → add ANTHROPIC_API_KEY (sk-ant-…). Without it Claude Code can't run app builds.{'\n'}3 · This repo → Settings → Actions → General → enable "Allow GitHub Actions to create and approve pull requests."{'\n'}Client-project repos get their ANTHROPIC_API_KEY and PR permissions set automatically when A.R.A. creates them, using the Anthropic key from the KEYS tab.</Text>
          </View>}
          {tab==='BACKEND'&&<View>
            <Text style={s.secTitle}>BACKEND SERVER</Text>
            <Text style={s.secSub}>Optional. Links this device to your Empire OS server for cross-device sync — tasks, memory, notes, revenue, dates — and routes every AI call through it so the provider keys live on the server, not in the app. Leave it blank to stay fully local.</Text>
            {beConfigured&&<View style={[s.tlAcctCard,{marginTop:0,marginBottom:16,borderColor:beSync.error?'#4a2c2c':'#2c4a38'}]}>
              <Text style={[s.tlAcctLine,{color:beSync.error?'#C7614B':'#5FA779'}]}>{beSync.error?'SYNC ERROR':beSync.running?'SYNCING…':'CONNECTED'}</Text>
              <Text style={s.beMeta}>{beSync.error?beSync.error:beSync.lastSync?'Last sync '+new Date(beSync.lastSync).toLocaleString():'Not synced yet'}</Text>
            </View>}
            <View style={s.keyField}>
              <Text style={s.keyLabel}>SERVER URL</Text>
              <TextInput style={s.keyInput} value={beUrl} onChangeText={setBeUrl} placeholder="https://your-app.replit.app" placeholderTextColor="#1A1A1A" autoCapitalize="none" autoCorrect={false} keyboardType="url"/>
            </View>
            <View style={s.keyField}>
              <Text style={s.keyLabel}>SYNC TOKEN</Text>
              <TextInput style={s.keyInput} value={beToken} onChangeText={setBeToken} placeholder="the SYNC_TOKEN server secret" placeholderTextColor="#1A1A1A" secureTextEntry autoCapitalize="none" autoCorrect={false}/>
            </View>
            <TouchableOpacity style={s.saveBtn} onPress={connectBackend} disabled={beBusy}>
              <Text style={s.saveBtnT}>{beBusy?'WORKING…':beConfigured?'RECONNECT':'CONNECT'}</Text>
            </TouchableOpacity>
            {beConfigured&&<View style={{flexDirection:'row',gap:10,marginTop:10}}>
              <TouchableOpacity style={[s.saveBtn,{flex:1,marginTop:0,backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={syncNow} disabled={beBusy}><Text style={[s.saveBtnT,{color:'#E8C98A'}]}>SYNC NOW</Text></TouchableOpacity>
              <TouchableOpacity style={[s.saveBtn,{flex:1,marginTop:0,backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={fullResync} disabled={beBusy}><Text style={[s.saveBtnT,{color:'#E8C98A'}]}>FULL RESYNC</Text></TouchableOpacity>
            </View>}
            {beConfigured&&<TouchableOpacity style={[s.saveBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333',marginTop:10}]} onPress={testPush} disabled={beBusy}>
              <Text style={[s.saveBtnT,{color:'#E8C98A'}]}>SEND TEST PUSH</Text>
            </TouchableOpacity>}
            {beConfigured&&<TouchableOpacity style={[s.saveBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333',marginTop:10}]} onPress={disconnectBackend}>
              <Text style={[s.saveBtnT,{color:'#E05555'}]}>DISCONNECT</Text>
            </TouchableOpacity>}
            <Text style={[s.secSub,{marginTop:20,marginBottom:0}]}>The token must match the server's SYNC_TOKEN secret exactly. Every device you connect with the same URL and token shares one dataset, last write wins. Nudges (morning briefing, routine and streak reminders, build-pipeline alerts) are sent by the server on a schedule.</Text>
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
            <TouchableOpacity style={s.toggleRow} onPress={cycleDeepModel} activeOpacity={0.7}>
              <View style={{flex:1,paddingRight:12}}>
                <Text style={s.toggleLabel}>DEEP RESEARCH MODEL</Text>
                <Text style={s.toggleSub}>{deepModel==='auto'?'Auto — try o3-deep-research, fall back to o4-mini if your account lacks access.':deepModel==='o3-deep-research'?'o3-deep-research — most thorough, needs OpenAI org verification.':'o4-mini-deep-research — faster and cheaper.'}</Text>
              </View>
              <Text style={[s.toggleLabel,{color:'#5B8DEF'}]}>{deepModel==='auto'?'AUTO':deepModel==='o3-deep-research'?'O3':'O4-MINI'}</Text>
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
  beMeta:{fontFamily:'monospace',fontSize:8,color:'#555',letterSpacing:1,marginTop:4,lineHeight:12},
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
