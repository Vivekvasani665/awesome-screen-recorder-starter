import {getToken,getFolders,saveFile} from "../lib/drive.js";

const IDLE={recording:false,paused:false,startedAt:null,pausedAt:null,totalPaused:0,recorderWindowId:null};

async function startRecording(){
  const {recorderWindowId}=await chrome.storage.local.get("recorderWindowId");
  if(recorderWindowId){
    try{await chrome.windows.update(recorderWindowId,{focused:true,state:"normal"});return}catch{}
  }
  // The recorder page shows Chrome's screen picker and records; it must stay open while recording.
  const w=await chrome.windows.create({url:chrome.runtime.getURL("recorder/recorder.html"),type:"popup",width:380,height:260,focused:true});
  await chrome.storage.local.set({...IDLE,recorderWindowId:w.id});
}

async function screenshot(){
  const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  if(!tab) throw new Error("No active tab to capture.");
  const dataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:"png"});
  const blob=await (await fetch(dataUrl)).blob();
  const name=`screenshot-${new Date().toISOString().replaceAll(":","-")}.png`;
  return saveFile({blob,url:dataUrl,name,mimeType:"image/png",kind:"screenshots"});
}

const handlers={
  async GET_STATE(){
    const s=await chrome.storage.local.get(["recording","paused","startedAt","pausedAt","totalPaused","driveConnected"]);
    return {...s,connected:!!s.driveConnected};
  },
  async CONNECT_DRIVE(){await getToken(true);await getFolders();await chrome.storage.local.set({driveConnected:true});return {ok:true}},
  async START_RECORDING(){await startRecording();return {ok:true}},
  async SCREENSHOT(){return {ok:true,...await screenshot()}},
};

chrome.runtime.onMessage.addListener((m,s,send)=>{
  const h=handlers[m?.type];
  if(!h) return false; // REC_* messages are handled by the recorder page
  h(m).then(send,e=>send({error:e.message}));
  return true;
});

// If the recorder window is closed, make sure the popup doesn't think we're still recording.
chrome.windows.onRemoved.addListener(async id=>{
  const {recorderWindowId}=await chrome.storage.local.get("recorderWindowId");
  if(id===recorderWindowId) await chrome.storage.local.set(IDLE);
});
chrome.runtime.onStartup.addListener(()=>chrome.storage.local.set(IDLE));
chrome.runtime.onInstalled.addListener(()=>chrome.storage.local.set(IDLE));
