import{create}from 'zustand';
const useEmpireStore=create((set,get)=>({
  keys:null,setKeys:(k)=>set({keys:k}),
  activePersona:'jarvis',setActivePersona:(id)=>set({activePersona:id}),
  mode:'direct',setMode:(m)=>set({mode:m}),
  customPersonas:[],setCustomPersonas:(p)=>set({customPersonas:p}),
  voiceEnabled:false,toggleVoice:()=>set(s=>({voiceEnabled:!s.voiceEnabled})),
  isLoading:false,setLoading:(v)=>set({isLoading:v}),
  hudState:null,setHudState:(s)=>set({hudState:s}),
  tasks:[],setTasks:(t)=>set({tasks:t}),
  personaPics:{},setPersonaPics:(p)=>set({personaPics:p}),
  messages:{jarvis:[],ara:[],selene:[],stephanie:[],rogue:[],atlas:[],haven:[],aisha:[],abraham:[],batman:[]},
  addMessage:(persona,msg)=>set(s=>({messages:{...s.messages,[persona]:[...(s.messages[persona]||[]),msg]}})),
  groupMessages:{council:[],empire:[],custom:[]},
  addGroupMessage:(mode,msg)=>set(s=>({groupMessages:{...s.groupMessages,[mode]:[...(s.groupMessages[mode]||[]),msg]}})),
  relayInbox:{},
  addRelay:(personaId,message)=>set(s=>({relayInbox:{...s.relayInbox,[personaId]:[...(s.relayInbox[personaId]||[]),message]}})),
  clearRelay:(personaId)=>set(s=>({relayInbox:{...s.relayInbox,[personaId]:[]}})),
  diagramPrompt:'',setDiagramPrompt:(p)=>set({diagramPrompt:p||''}),
  // Live problems surfaced in the top notification bar (NudgeBar). Keyed so the
  // same issue can't stack; cleared when the matching thing succeeds.
  firmIssues:{}, // {key:{text,detail,severity}}
  flagFirmIssue:(key,text,detail=null,severity='error')=>set(s=>({firmIssues:{...s.firmIssues,[key]:{text,detail,severity}}})),
  clearFirmIssue:(key)=>set(s=>{if(!(key in s.firmIssues))return{};const n={...s.firmIssues};delete n[key];return{firmIssues:n};}),
}));
export default useEmpireStore;
