import {getToken,getFolders,getAccountEmail,saveFile} from "../lib/drive.js";
import {addHistory,getHistory,makeThumb,stamp} from "../lib/history.js";

const IDLE={recording:false,paused:false,startedAt:null,pausedAt:null,totalPaused:0,recorderWindowId:null,recInfo:null,saving:false};

async function startRecording(){
  const {recorderWindowId}=await chrome.storage.local.get("recorderWindowId");
  if(recorderWindowId){
    try{await chrome.windows.update(recorderWindowId,{focused:true,state:"normal"});return}catch{}
  }
  // The recorder page shows Chrome's screen picker and records; it must stay open while recording.
  const w=await chrome.windows.create({url:chrome.runtime.getURL("recorder/recorder.html"),type:"popup",width:360,height:430,focused:true});
  await chrome.storage.local.set({...IDLE,recorderWindowId:w.id});
}

let screenshotAbort=null;

async function screenshot(){
  screenshotAbort=new AbortController();
  const {signal}=screenshotAbort;
  try{
    const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
    if(!tab) throw new Error("No active tab to capture.");
    const dataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:"png"});
    const blob=await (await fetch(dataUrl)).blob();
    signal.throwIfAborted();
    let thumb;
    try{const bmp=await createImageBitmap(blob);thumb=await makeThumb(bmp,bmp.width,bmp.height);bmp.close()}catch{}
    const name=`Screenshot ${stamp()}.png`;
    const r=await saveFile({blob,url:dataUrl,name,mimeType:"image/png",kind:"screenshots",signal});
    await addHistory({kind:"screenshot",name,size:blob.size,thumb,status:r.where==="drive"?"uploaded":"local",
      webViewLink:r.webViewLink,downloadId:r.downloadId,error:r.warning});
    return r;
  }finally{screenshotAbort=null}
}

const handlers={
  async CONNECT_DRIVE(){
    await getToken(true);
    const {root}=await getFolders();
    const driveEmail=await getAccountEmail().catch(()=>"");
    await chrome.storage.local.set({driveConnected:true,driveEmail,rootFolderId:root});
    return {ok:true,email:driveEmail};
  },
  async DISCONNECT_DRIVE(){
    await chrome.identity.clearAllCachedAuthTokens();
    await chrome.storage.local.set({driveConnected:false,driveEmail:"",rootFolderId:null});
    return {ok:true};
  },
  async START_RECORDING(){await startRecording();return {ok:true}},
  async SCREENSHOT(){
    try{return {ok:true,...await screenshot()}}
    catch(e){if(e.name==="AbortError") return {cancelled:true};throw e}
  },
  async CANCEL_SCREENSHOT(){screenshotAbort?.abort();return {ok:true}},
};

chrome.runtime.onMessage.addListener((m,s,send)=>{
  const h=handlers[m?.type];
  if(!h) return false; // REC_* messages are handled by the recorder page
  h(m).then(send,e=>send({error:e.message}));
  return true;
});

// Recording uploads run in the recorder window; if it goes away mid-upload, that upload is lost.
async function failInterruptedUploads(){
  const h=await getHistory();
  if(!h.some(e=>e.status==="uploading"||e.status==="saving")) return;
  await chrome.storage.local.set({history:h.map(e=>e.status==="uploading"||e.status==="saving"?{...e,status:"failed",error:"The recorder window was closed before saving finished."}:e)});
}
async function reset(){await chrome.storage.local.set(IDLE);await failInterruptedUploads()}

// If the recorder window is closed, make sure the popup doesn't think we're still recording.
chrome.windows.onRemoved.addListener(async id=>{
  const {recorderWindowId}=await chrome.storage.local.get("recorderWindowId");
  if(id===recorderWindowId) await reset();
});
chrome.runtime.onStartup.addListener(reset);
chrome.runtime.onInstalled.addListener(reset);
