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
}));
export default useEmpireStore;
