import {getToken,getFolders,getAccountEmail,saveFile,shareUploadedFile} from "../lib/drive.js";
import {addHistory,getHistory,updateHistory,makeThumb,stamp} from "../lib/history.js";

const IDLE={recording:false,paused:false,startedAt:null,pausedAt:null,totalPaused:0,recorderWindowId:null,recInfo:null,saving:false};

async function startRecording(){
  const {recorderWindowId}=await chrome.storage.local.get("recorderWindowId");
  if(recorderWindowId){
    try{await chrome.windows.update(recorderWindowId,{focused:true,state:"normal"});return}catch{}
  }
  // The recorder page shows Chrome's screen picker and records; it must stay open while recording.
  const w=await chrome.windows.create({url:chrome.runtime.getURL("recorder/recorder.html"),type:"popup",width:380,height:560,focused:true});
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
    await chrome.storage.local.set({shotStage:"uploading"});
    const r=await saveFile({blob,url:dataUrl,name,mimeType:"image/png",kind:"screenshots",signal});
    if(r.where!=="drive"){
      const id=await addHistory({kind:"screenshot",name,size:blob.size,thumb,status:"local",downloadId:r.downloadId,error:r.warning});
      return {...r,id};
    }
    // Uploaded: the link is only "ready" once the public permission and metadata calls succeed.
    const id=await addHistory({kind:"screenshot",name,size:blob.size,thumb,status:"sharing",fileId:r.fileId,driveUrl:r.webViewLink,downloadId:r.downloadId});
    await chrome.storage.local.set({shotStage:"sharing"});
    const patch=await shareUploadedFile(r.fileId);
    await updateHistory(id,patch);
    return {...r,id,...patch};
  }finally{screenshotAbort=null;await chrome.storage.local.set({shotStage:null})}
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
  // Re-runs only permission + metadata for an already-uploaded file; never re-uploads.
  async RETRY_LINK({id}){
    const e=(await getHistory()).find(x=>x.id===id);
    if(!e?.fileId) throw new Error("This item has no uploaded Drive file to share.");
    await updateHistory(id,{status:"sharing",shareError:null});
    const patch=await shareUploadedFile(e.fileId);
    await updateHistory(id,patch);
    return patch;
  },
};

chrome.runtime.onMessage.addListener((m,s,send)=>{
  const h=handlers[m?.type];
  if(!h) return false; // REC_* messages are handled by the recorder page
  h(m).then(send,e=>send({error:e.message}));
  return true;
});

// Recording uploads run in the recorder window; if it goes away mid-upload, that upload is lost.
// An item that was already uploaded but still "sharing" keeps its fileId so Retry Link can finish it.
async function failInterrupted(kinds){
  const h=await getHistory();
  const fix=e=>{
    if(!kinds.includes(e.kind)) return e;
    if(e.status==="uploading"||e.status==="saving") return {...e,status:"failed",error:"Saving was interrupted before it finished."};
    if(e.status==="sharing") return {...e,status:"share_failed",shareError:"Link generation was interrupted."};
    return e;
  };
  const next=h.map(fix);
  if(next.some((e,i)=>e!==h[i])) await chrome.storage.local.set({history:next});
}
async function reset(kinds=["recording","screenshot"]){await chrome.storage.local.set({...IDLE,shotStage:null});await failInterrupted(kinds)}

// If the recorder window is closed, make sure the popup doesn't think we're still recording.
chrome.windows.onRemoved.addListener(async id=>{
  const {recorderWindowId}=await chrome.storage.local.get("recorderWindowId");
  if(id===recorderWindowId) await reset(["recording"]);
});
chrome.runtime.onStartup.addListener(()=>reset());
chrome.runtime.onInstalled.addListener(()=>reset());
