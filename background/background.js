import {connectInteractive,disconnect,explainAuthError,getFolders,getAccountEmail,saveFile,shareUploadedFile,deleteDriveFile} from "../lib/drive.js";
import {addHistory,getHistory,updateHistory,removeHistory,makeThumb,stamp} from "../lib/history.js";

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
    await chrome.storage.local.set({shotStage:"sharing"});
    // Link first: the history entry (with its share link) appears before the image upload starts.
    let id=null;
    const onLink=async({fileId,driveUrl,share})=>{
      id=await addHistory({kind:"screenshot",name,size:blob.size,thumb,status:"uploading",progress:0,fileId,driveUrl,...share});
      await chrome.storage.local.set({shotStage:"uploading"});
    };
    let r;
    try{r=await saveFile({blob,url:dataUrl,name,mimeType:"image/png",kind:"screenshots",signal,onLink})}
    catch(e){if(id) await removeHistory(id);throw e} // cancelled: the Drive placeholder was already deleted
    if(r.where!=="drive"){
      const local={status:"local",downloadId:r.downloadId,error:r.warning,fileId:null,driveUrl:null,shared:false,webViewLink:null};
      if(id) await updateHistory(id,local);
      else id=await addHistory({kind:"screenshot",name,size:blob.size,thumb,...local});
      return {...r,id};
    }
    const patch={status:r.share.shared?"uploaded":"share_failed",progress:100,downloadId:r.downloadId};
    await updateHistory(id,patch);
    return {...r,id,...r.share,...patch};
  }finally{screenshotAbort=null;await chrome.storage.local.set({shotStage:null})}
}

const handlers={
  // The only place a Google sign-in window may open: the user clicked "Connect Google Drive".
  async CONNECT_DRIVE(){
    await chrome.storage.local.set({driveAuthError:null});
    try{
      await connectInteractive();
      // Proves the token really works with Drive (API enabled, folders writable) before showing "Connected".
      const {root}=await getFolders();
      const driveEmail=await getAccountEmail().catch(()=>"");
      await chrome.storage.local.set({driveConnected:true,driveEmail,rootFolderId:root});
      return {ok:true,email:driveEmail};
    }catch(e){
      // Google's sign-in window usually closes the popup, so the reply is lost; keep the error for the next popup open.
      const x=readable(e);
      await chrome.storage.local.set({driveAuthError:x.message});
      throw x;
    }
  },
  async DISCONNECT_DRIVE(){
    await disconnect();
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

// DriveErrors already carry a readable message; anything from chrome.identity is translated.
const readable=e=>e?.name==="DriveError"||!/identity|oauth|token|sign/i.test(e?.message||"")?e:explainAuthError(e);

chrome.runtime.onMessage.addListener((m,s,send)=>{
  const h=handlers[m?.type];
  if(!h) return false; // REC_* messages are handled by the recorder page
  h(m).then(send,e=>send({error:readable(e).message}));
  return true;
});

// Recording uploads run in the recorder window; if it goes away mid-upload, that upload is lost.
// An item that was already uploaded but still "sharing" keeps its fileId so Retry Link can finish it.
async function failInterrupted(kinds){
  const h=await getHistory();
  const fix=e=>{
    if(!kinds.includes(e.kind)) return e;
    if(e.status==="uploading"||e.status==="saving"){
      // The link-first placeholder never received its content; remove it so the shared link isn't left pointing at an empty file.
      if(e.fileId) deleteDriveFile(e.fileId).catch(()=>{});
      return {...e,status:"failed",error:"Saving was interrupted before it finished.",fileId:null,shared:false,webViewLink:null};
    }
    if(e.status==="sharing") return e.fileId?{...e,status:"share_failed",shareError:"Link generation was interrupted."}
      :{...e,status:"failed",error:"Saving was interrupted before it finished."};
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
