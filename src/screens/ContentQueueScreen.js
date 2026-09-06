// The AI-influencer content review queue. The page personas (muse1/2/3) write
// prompts + captions; F.O.R.G.E. compiles the batch and (with a Higgsfield key
// set) submits it — the finished media appears here on its own; then Mr. Burrus
// approves, and H.E.R.A.L.D. publishes the approved ones to Instagram / Facebook.
//
// Status flow: queued -> awaiting_media -> needs_review -> approved -> posted
// (plus rejected / failed). While 'awaiting_media' has a gen_job_id it's
// generating on Higgsfield. Nothing leaves this screen for social without an
// approve tap.
import React,{useCallback,useEffect,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView,TextInput,Image,Alert}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import{Video,ResizeMode}from 'expo-av';
import*as ImagePicker from 'expo-image-picker';
import*as DocumentPicker from 'expo-document-picker';
import*as Clipboard from 'expo-clipboard';
import Boundary from './hud/Boundary';
import{FONTS}from '../theme';
import{getContentItems,getContentPages,setContentPages,updateContentItem,deleteContentItem}from '../services/database';
import{compileBatch}from '../services/socialPublish';
import{pollContentJobs}from '../services/contentJobs';

const POLL_MS=4000;
const PAGES=['muse1','muse2','muse3'];
const PAGE_COLOR={muse1:'#EC4899',muse2:'#14B8A6',muse3:'#F59E0B'};
const STATUS_COLOR={
  queued:'#8a8069',awaiting_media:'#D9A441',needs_review:'#7C83FF',
  approved:'#5FA779',posted:'#5FA779',rejected:'#C7614B',failed:'#C7614B',
};
const STATUS_LABEL={
  queued:'QUEUED',awaiting_media:'NEEDS MEDIA',needs_review:'REVIEW',
  approved:'APPROVED · WAITING TO POST',posted:'POSTED',rejected:'REJECTED',failed:'FAILED',
};
// awaiting_media splits by whether Higgsfield is generating it.
function statusLabel(it){
  if(it.status==='awaiting_media'&&it.gen_job_id){
    return it.gen_phase==='video'?'ANIMATING…':'RENDERING…';
  }
  return STATUS_LABEL[it.status]||String(it.status||'').toUpperCase();
}
const isGenerating=it=>it.status==='awaiting_media'&&!!it.gen_job_id;

export default function ContentQueueScreen({navigation}){
  return(
    <Boundary label="The content queue">
      <ContentQueue navigation={navigation}/>
    </Boundary>
  );
}

function ContentQueue({navigation}){
  const[items,setItems]=useState([]);
  const[pages,setPages]=useState({});
  const[tab,setTab]=useState('queue');      // 'queue' | 'pages'
  const[filter,setFilter]=useState(null);   // null = all pages
  const[caps,setCaps]=useState({});         // id -> in-progress caption edit
  const[busy,setBusy]=useState(false);
  const[pf,setPf]=useState({});             // page-setup form: {muse1:{name,handle,soul_id,...}}
  const[pfSaved,setPfSaved]=useState(false);

  const load=useCallback(async(alive)=>{
    try{const i=await getContentItems({});if(alive())setItems(i);}catch{}
    try{const p=await getContentPages();if(alive())setPages(p||{});}catch{}
  },[]);

  // Seed the Pages form once, from whatever config is stored; after that the
  // form owns its state so the background poll doesn't stomp an edit.
  useEffect(()=>{setPf(prev=>Object.keys(prev).length?prev:pages);},[pages]);
  const setPageField=(page,k,val)=>setPf(f=>({...f,[page]:{...(f[page]||{}),[k]:val}}));
  const savePages=async()=>{
    try{
      const merged={...pages};
      for(const p of PAGES)merged[p]={...(merged[p]||{}),...(pf[p]||{})};
      await setContentPages(merged);
      setPages(merged);
      setPfSaved(true);setTimeout(()=>setPfSaved(false),2000);
    }catch(e){Alert.alert('Save failed',String(e.message||e));}
  };

  useFocusEffect(useCallback(()=>{
    let on=true;const alive=()=>on;
    load(alive);
    const iv=setInterval(async()=>{
      try{await pollContentJobs();}catch{}
      if(alive())load(alive);
    },POLL_MS);
    return()=>{on=false;clearInterval(iv);};
  },[load]));

  const patch=async(id,p)=>{await updateContentItem(id,p).catch(()=>{});load(()=>true);};

  const attach=async(item)=>{
    try{
      const wantVideo=item.kind==='reel';
      let uri=null,type=wantVideo?'video':'image';
      const pick=await ImagePicker.launchImageLibraryAsync({
        mediaTypes:wantVideo?ImagePicker.MediaTypeOptions.Videos:ImagePicker.MediaTypeOptions.Images,
        quality:1,
      });
      if(!pick.canceled&&pick.assets&&pick.assets[0]){
        uri=pick.assets[0].uri;
        if(pick.assets[0].type)type=pick.assets[0].type;
      }else{
        const doc=await DocumentPicker.getDocumentAsync({type:wantVideo?'video/*':'image/*',copyToCacheDirectory:true});
        if(!doc.canceled&&doc.assets&&doc.assets[0]){uri=doc.assets[0].uri;type=wantVideo?'video':'image';}
      }
      if(!uri)return;
      await patch(item.id,{media_uri:uri,media_type:type,status:'needs_review',error:'',gen_job_id:'',gen_phase:''});
    }catch(e){Alert.alert('Attach failed',String(e.message||e));}
  };

  const compile=async(page)=>{
    setBusy(true);
    try{const res=await compileBatch(page);Alert.alert('F.O.R.G.E.',res.split('\n').slice(0,2).join('\n'));}
    catch(e){Alert.alert('Compile failed',String(e.message||e));}
    setBusy(false);
    load(()=>true);
  };

  const shown=filter?items.filter(i=>i.page===filter):items;
  const tally=PAGES.reduce((a,p)=>{a[p]=items.filter(i=>i.page===p).length;return a;},{});
  const generating=items.filter(isGenerating).length;
  const needMedia=items.filter(i=>i.status==='awaiting_media'&&!i.gen_job_id).length;
  const toReview=items.filter(i=>i.status==='needs_review').length;
  const approved=items.filter(i=>i.status==='approved').length;
  const subParts=[
    generating&&`${generating} generating`,
    needMedia&&`${needMedia} need media`,
    `${toReview} to review`,
    `${approved} approved`,
  ].filter(Boolean);

  return(
    <SafeAreaView style={s.safe} edges={['top','bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={()=>navigation.navigate('Map')} hitSlop={{top:12,bottom:12,left:12,right:12}}>
          <Text style={s.back}>‹ MAP</Text>
        </TouchableOpacity>
        <View style={{flex:1,alignItems:'center'}}>
          <Text style={s.title}>{tab==='pages'?'PAGE SETUP':'CONTENT QUEUE'}</Text>
          {tab!=='pages'&&<Text style={s.sub}>{subParts.join(' · ')}</Text>}
        </View>
        <View style={{width:44}}/>
      </View>

      <View style={s.tabs}>
        <Tab label="QUEUE" active={tab==='queue'} onPress={()=>setTab('queue')}/>
        <Tab label="PAGES" active={tab==='pages'} onPress={()=>setTab('pages')}/>
      </View>

      {tab==='pages'&&(
        <ScrollView contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
          <Text style={s.pgIntro}>One influencer per page. The Soul ID is that page's trained Higgsfield character — every reel and post for the page renders with it, so the three stay distinct and consistent. Create each character in Higgsfield, then paste its ID here.</Text>
          {PAGES.map(p=>{
            const v=pf[p]||{};
            return(
              <View key={p} style={[s.card,{borderColor:(PAGE_COLOR[p]||'#888')+'44'}]}>
                <Text style={[s.page,{color:PAGE_COLOR[p]}]}>{p.toUpperCase()}</Text>
                <Field label="NAME" value={v.name} onChangeText={t=>setPageField(p,'name',t)} placeholder="influencer name"/>
                <Field label="HANDLE" value={v.handle} onChangeText={t=>setPageField(p,'handle',t)} placeholder="@handle" autoCapitalize="none"/>
                <Field label="HIGGSFIELD SOUL ID" value={v.soul_id} onChangeText={t=>setPageField(p,'soul_id',t)} placeholder="custom reference id" autoCapitalize="none"/>
                <Field label="SOUL STRENGTH  (0–1, default 0.8)" value={v.soul_strength} onChangeText={t=>setPageField(p,'soul_strength',t)} placeholder="0.8" keyboardType="decimal-pad"/>
                <Text style={s.pgHdr}>PUBLISHING — needed later for H.E.R.A.L.D.</Text>
                <Field label="INSTAGRAM USER ID" value={v.ig_user_id} onChangeText={t=>setPageField(p,'ig_user_id',t)} placeholder="IG business account id" autoCapitalize="none"/>
                <Field label="FACEBOOK PAGE ID" value={v.fb_page_id} onChangeText={t=>setPageField(p,'fb_page_id',t)} placeholder="linked FB page id" autoCapitalize="none"/>
                <Field label="ACCESS TOKEN" value={v.access_token} onChangeText={t=>setPageField(p,'access_token',t)} placeholder="long-lived page token" autoCapitalize="none" secureTextEntry/>
              </View>
            );
          })}
          <TouchableOpacity style={s.saveBtn} onPress={savePages}>
            <Text style={s.saveBtnT}>{pfSaved?'✓ SAVED':'SAVE PAGES'}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {tab==='queue'&&<>
      <View style={s.filters}>
        <Chip label="ALL" active={!filter} color="#C9BEA6" onPress={()=>setFilter(null)}/>
        {PAGES.map(p=>(
          <Chip key={p} label={`${pages[p]?.name||p.toUpperCase()} ${tally[p]||0}`} active={filter===p}
            color={PAGE_COLOR[p]} onPress={()=>setFilter(filter===p?null:p)}/>
        ))}
      </View>

      {items.some(i=>i.status==='queued')&&(
        <TouchableOpacity style={s.compileBar} disabled={busy} activeOpacity={0.8}
          onPress={()=>compile(filter)}>
          <Text style={s.compileT}>{busy?'COMPILING…':`◆ COMPILE ${filter?(pages[filter]?.name||filter.toUpperCase())+"'S":'ALL'} QUEUED → BATCH`}</Text>
        </TouchableOpacity>
      )}

      <ScrollView contentContainerStyle={s.list}>
        {!shown.length&&<Text style={s.empty}>Nothing here yet. The page personas queue content in chat, then F.O.R.G.E. compiles the batch.</Text>}
        {shown.map(it=>{
          const sc=STATUS_COLOR[it.status]||'#888';
          const pc=PAGE_COLOR[it.page]||'#888';
          const capVal=caps[it.id]!==undefined?caps[it.id]:(it.caption||'');
          return(
            <View key={it.id} style={[s.card,{borderColor:pc+'44'}]}>
              <View style={s.cardTop}>
                <Text style={[s.page,{color:pc}]}>{pages[it.page]?.name||it.page.toUpperCase()}</Text>
                <Text style={s.meta}>{it.kind}{it.slot?` · ${it.slot}`:''}</Text>
                <View style={{flex:1}}/>
                <Text style={[s.status,{color:sc}]}>{statusLabel(it)}</Text>
              </View>

              {['queued','awaiting_media'].includes(it.status)&&(
                <TouchableOpacity onPress={()=>{Clipboard.setStringAsync(it.prompt||'');Alert.alert('Copied','Prompt copied.');}}>
                  <Text style={s.prompt} numberOfLines={6}>{it.prompt||'(no prompt)'}</Text>
                  <Text style={s.tapHint}>{isGenerating(it)
                    ?(it.gen_phase==='video'?'Higgsfield is animating the still…':'Higgsfield is rendering this…')
                    :'tap to copy prompt'}</Text>
                </TouchableOpacity>
              )}

              {isGenerating(it)&&!!it.thumb_uri&&(
                <Image source={{uri:it.thumb_uri}} style={s.media} resizeMode="cover"/>
              )}

              {!!it.media_uri&&(it.media_type==='video'
                ?<Video source={{uri:it.media_uri}} style={s.media} resizeMode={ResizeMode.COVER} useNativeControls isLooping/>
                :<Image source={{uri:it.media_uri}} style={s.media} resizeMode="cover"/>)}

              {it.status==='needs_review'&&(
                <TextInput style={s.caption} value={capVal} multiline placeholder="caption…" placeholderTextColor="#4a463c"
                  onChangeText={t=>setCaps(c=>({...c,[it.id]:t}))}
                  onEndEditing={()=>{if(capVal!==(it.caption||''))patch(it.id,{caption:capVal});}}/>
              )}
              {['approved','posted'].includes(it.status)&&!!it.caption&&<Text style={s.capRO}>{it.caption}</Text>}
              {!!it.hashtags&&<Text style={s.tags}>{it.hashtags}</Text>}
              {!!it.error&&<Text style={s.err}>{it.error}</Text>}
              {!!it.posted_url&&<Text style={s.link}>{it.posted_url}</Text>}

              <View style={s.actions}>
                {it.status==='awaiting_media'&&<Btn label={isGenerating(it)?'ATTACH MANUALLY':'ATTACH MEDIA'} onPress={()=>attach(it)}/>}
                {it.status==='needs_review'&&<>
                  <Btn label="APPROVE" primary onPress={()=>patch(it.id,{caption:capVal,status:'approved'})}/>
                  <Btn label="REDO MEDIA" onPress={()=>attach(it)}/>
                  <Btn label="REJECT" danger onPress={()=>patch(it.id,{status:'rejected',note:'rejected in review'})}/>
                </>}
                {it.status==='approved'&&<Btn label="UNAPPROVE" onPress={()=>patch(it.id,{status:'needs_review'})}/>}
                {['rejected','failed'].includes(it.status)&&<Btn label="REQUEUE" onPress={()=>patch(it.id,{status:'queued',media_uri:'',gen_job_id:'',gen_phase:'',error:''})}/>}
                {it.status!=='posted'&&<Btn label="DELETE" danger onPress={()=>{
                  Alert.alert('Delete this item?','',[{text:'Cancel'},{text:'Delete',style:'destructive',onPress:async()=>{await deleteContentItem(it.id);load(()=>true);}}]);
                }}/>}
              </View>
            </View>
          );
        })}
      </ScrollView>
      </>}
    </SafeAreaView>
  );
}

function Chip({label,active,color,onPress}){
  return(
    <TouchableOpacity onPress={onPress} style={[s.chip,active&&{borderColor:color,backgroundColor:color+'22'}]}>
      <Text style={[s.chipT,active&&{color}]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}
function Tab({label,active,onPress}){
  return(
    <TouchableOpacity onPress={onPress} style={[s.tab,active&&s.tabActive]}>
      <Text style={[s.tabT,active&&s.tabTActive]}>{label}</Text>
    </TouchableOpacity>
  );
}
function Field({label,value,...p}){
  return(
    <View style={s.field}>
      <Text style={s.fieldL}>{label}</Text>
      <TextInput style={s.fieldI} placeholderTextColor="#3a362e" autoCorrect={false}
        value={value==null?'':String(value)} {...p}/>
    </View>
  );
}
function Btn({label,onPress,primary,danger}){
  return(
    <TouchableOpacity onPress={onPress} style={[s.btn,primary&&s.btnPrimary,danger&&s.btnDanger]}>
      <Text style={[s.btnT,primary&&{color:'#0A0907'},danger&&{color:'#E8938C'}]}>{label}</Text>
    </TouchableOpacity>
  );
}

const s=StyleSheet.create({
  safe:{flex:1,backgroundColor:'#000'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:14,paddingTop:6,paddingBottom:4},
  back:{fontFamily:FONTS.mono,fontSize:10,color:'#7fa8c9',letterSpacing:2,width:44},
  title:{fontFamily:FONTS.mono,fontSize:11,color:'#C9BEA6',letterSpacing:3},
  sub:{fontFamily:FONTS.mono,fontSize:8,color:'#6a6250',letterSpacing:1,marginTop:2},
  filters:{flexDirection:'row',gap:6,paddingHorizontal:12,paddingVertical:8,flexWrap:'wrap'},
  chip:{borderWidth:1,borderColor:'#2A2620',borderRadius:14,paddingHorizontal:10,paddingVertical:5},
  chipT:{fontFamily:FONTS.mono,fontSize:8,color:'#8a8069',letterSpacing:1},
  tabs:{flexDirection:'row',gap:6,paddingHorizontal:12,paddingTop:8,paddingBottom:2},
  tab:{borderWidth:1,borderColor:'#2A2620',borderRadius:6,paddingHorizontal:18,paddingVertical:6},
  tabActive:{borderColor:'#C9BEA6',backgroundColor:'#C9BEA622'},
  tabT:{fontFamily:FONTS.mono,fontSize:9,color:'#8a8069',letterSpacing:2},
  tabTActive:{color:'#C9BEA6'},
  pgIntro:{fontFamily:FONTS.mono,fontSize:9,color:'#6a6250',lineHeight:15,marginBottom:2},
  pgHdr:{fontFamily:FONTS.mono,fontSize:7,color:'#5a5145',letterSpacing:2,marginTop:8,marginBottom:1},
  field:{gap:3},
  fieldL:{fontFamily:FONTS.mono,fontSize:7,color:'#7a715d',letterSpacing:1.5},
  fieldI:{fontFamily:FONTS.mono,fontSize:11,color:'#C9BEA6',borderWidth:1,borderColor:'#1F1B14',borderRadius:6,paddingHorizontal:8,paddingVertical:7,backgroundColor:'#050403'},
  saveBtn:{borderWidth:1,borderColor:'#5FA779',borderRadius:8,paddingVertical:13,alignItems:'center',marginTop:8},
  saveBtnT:{fontFamily:FONTS.mono,fontSize:10,color:'#5FA779',letterSpacing:2},
  compileBar:{marginHorizontal:12,marginBottom:4,borderWidth:1,borderColor:'#7A6326',borderRadius:8,backgroundColor:'#171207',paddingVertical:10,alignItems:'center'},
  compileT:{fontFamily:FONTS.mono,fontSize:9,color:'#E8C98A',letterSpacing:1.5},
  list:{padding:12,gap:12,paddingBottom:40},
  empty:{fontFamily:FONTS.mono,fontSize:9,color:'#5a5145',lineHeight:16,textAlign:'center',marginTop:30,paddingHorizontal:20},
  card:{borderWidth:1,borderRadius:10,backgroundColor:'#0A0907',padding:12,gap:8},
  cardTop:{flexDirection:'row',alignItems:'center',gap:8},
  page:{fontFamily:FONTS.mono,fontSize:9,fontWeight:'700',letterSpacing:1.5},
  meta:{fontFamily:FONTS.mono,fontSize:8,color:'#8a8069'},
  status:{fontFamily:FONTS.mono,fontSize:7,letterSpacing:1},
  prompt:{fontFamily:FONTS.mono,fontSize:10,color:'#B7AC97',lineHeight:15},
  tapHint:{fontFamily:FONTS.mono,fontSize:7,color:'#4a463c',marginTop:3,letterSpacing:1},
  media:{width:'100%',height:200,borderRadius:6,backgroundColor:'#000',marginTop:2},
  caption:{fontFamily:FONTS.mono,fontSize:11,color:'#C9BEA6',borderWidth:1,borderColor:'#1F1B14',borderRadius:6,padding:8,minHeight:60,textAlignVertical:'top'},
  capRO:{fontFamily:FONTS.mono,fontSize:10,color:'#8a8069',lineHeight:15},
  tags:{fontFamily:FONTS.mono,fontSize:9,color:'#7fa8c9'},
  err:{fontFamily:FONTS.mono,fontSize:9,color:'#C7614B'},
  link:{fontFamily:FONTS.mono,fontSize:9,color:'#7fa8c9'},
  actions:{flexDirection:'row',flexWrap:'wrap',gap:6,marginTop:2},
  btn:{borderWidth:1,borderColor:'#2A2620',borderRadius:6,paddingHorizontal:10,paddingVertical:7},
  btnPrimary:{borderColor:'#5FA779',backgroundColor:'#5FA779'},
  btnDanger:{borderColor:'#7A2E2E'},
  btnT:{fontFamily:FONTS.mono,fontSize:8,color:'#9a917d',letterSpacing:1},
});
