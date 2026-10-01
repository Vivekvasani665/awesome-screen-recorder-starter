import {saveFile} from "../lib/drive.js";
import {getSettings} from "../lib/settings.js";
import {addHistory,updateHistory,getHistory,makeThumb,stamp} from "../lib/history.js";
import {ICONS,fillIcons,waveBars,clock} from "../popup/icons.js";
import {shareCard,bindShareActions,driveFileUrl} from "../popup/share-card.js";

const $=s=>document.querySelector(s);
const msg=(t,type="")=>{const e=$("#message");e.textContent=t;e.className=`rec-msg ${type}`};
const IDLE={recording:false,paused:false,startedAt:null,pausedAt:null,totalPaused:0,recInfo:null};
const QUALITY={"720":[1280,720],"1080":[1920,1080],"1440":[2560,1440]};
const MIMES={
  webm:["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"],
  mp4:["video/mp4;codecs=avc1,mp4a.40.2","video/mp4"],
};
const SURFACE={monitor:"screen",window:"window",browser:"tab"};

let settings,recorder=null,display=null,mic=null,audioCtx=null,chunks=[],startedAt=0,pausedAt=null,totalPaused=0,timer=null,thumb=null,format;

function pickFormat(){
  for(const ext of [settings.format,"webm"]){
    const mime=(MIMES[ext]||[]).find(t=>MediaRecorder.isTypeSupported(t));
    if(mime) return {mime,ext,type:mime.split(";")[0]};
  }
  return {mime:"",ext:"webm",type:"video/webm"};
}

function pickSource(){
  const sources=["screen","window","tab",...(settings.systemAudio?["audio"]:[])];
  return new Promise(resolve=>chrome.desktopCapture.chooseDesktopMedia(sources,(id,opts)=>resolve({id,audio:!!opts?.canRequestAudioTrack})));
}

async function getDisplay(id,audio){
  const [w,h]=QUALITY[settings.quality]||[];
  const base={chromeMediaSource:"desktop",chromeMediaSourceId:id};
  const video={mandatory:{...base,maxFrameRate:settings.fps,...(w?{maxWidth:w,maxHeight:h}:{})}};
  try{return await navigator.mediaDevices.getUserMedia({video,audio:audio?{mandatory:base}:false})}
  catch(e){if(audio) return navigator.mediaDevices.getUserMedia({video,audio:false});throw e}
}

// Mixes system audio and microphone into one track (MediaRecorder records a single audio track).
async function buildStream(){
  if(settings.microphone){
    try{mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}})}
    catch{mic=null;msg("Microphone permission was denied — recording without the microphone.","error")}
  }
  const sources=[display,mic].filter(s=>s?.getAudioTracks().length);
  if(sources.length<2) return new MediaStream([...display.getVideoTracks(),...(sources[0]?.getAudioTracks()||[])]);
  audioCtx=new AudioContext();
  const dest=audioCtx.createMediaStreamDestination();
  for(const s of sources) audioCtx.createMediaStreamSource(s).connect(dest);
  return new MediaStream([...display.getVideoTracks(),...dest.stream.getAudioTracks()]);
}

async function grabThumb(){
  try{
    const v=document.createElement("video");
    v.muted=true;v.srcObject=new MediaStream(display.getVideoTracks());
    await v.play();
    await new Promise(r=>setTimeout(r,300));
    thumb=await makeThumb(v,v.videoWidth,v.videoHeight);
    v.srcObject=null;
  }catch{thumb=null}
}

async function start(){
  settings=await getSettings();
  const {id,audio}=await pickSource();
  if(!id){await chrome.storage.local.set(IDLE);window.close();return}
  try{display=await getDisplay(id,audio)}
  catch(e){
    msg(`Could not capture the screen: ${e.message}. On macOS, allow Chrome in System Settings → Privacy & Security → Screen Recording, then restart Chrome.`,"error");
    $("#status").textContent="Failed";
    await chrome.storage.local.set(IDLE);return;
  }
  // User clicked Chrome's "Stop sharing" bar
  display.getVideoTracks()[0].addEventListener("ended",stop);

  const stream=await buildStream();
  format=pickFormat();
  chunks=[];startedAt=Date.now();totalPaused=0;pausedAt=null;
  recorder=new MediaRecorder(stream,{...(format.mime?{mimeType:format.mime}:{}),videoBitsPerSecond:settings.bitrate,audioBitsPerSecond:128000});
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  recorder.onstop=finish;
  recorder.start(1000);

  const surface=SURFACE[display.getVideoTracks()[0].getSettings().displaySurface]||"screen";
  const recInfo={surface,mic:!!mic,systemAudio:display.getAudioTracks().length>0};
  await chrome.storage.local.set({recording:true,paused:false,startedAt,pausedAt:null,totalPaused:0,recInfo});

  $("#status").textContent="Recording…";
  $("#sub").textContent=`Recording your ${surface}`;
  $("#wave").classList.remove("paused");
  $("#controls").classList.remove("hidden");
  if(!settings.microphone||mic) msg("Recording. Use the extension popup or this window to pause or stop.");
  timer=setInterval(()=>{$("#timer").textContent=clock((pausedAt??Date.now())-startedAt-totalPaused)},500);
  await grabThumb();
  try{const w=await chrome.windows.getCurrent();await chrome.windows.update(w.id,{state:"minimized"})}catch{}
}

async function togglePause(){
  if(!recorder) return;
  if(recorder.state==="recording"){recorder.pause();pausedAt=Date.now()}
  else if(recorder.state==="paused"){recorder.resume();totalPaused+=Date.now()-pausedAt;pausedAt=null}
  const paused=recorder.state==="paused";
  $("#pause span:last-child").textContent=paused?"Resume":"Pause";
  $("#pause .ico-sm").innerHTML=ICONS[paused?"play":"pause"];
  $("#status").textContent=paused?"Paused":"Recording…";
  $("#wave").classList.toggle("paused",paused);
  await chrome.storage.local.set({paused,pausedAt,totalPaused});
}

function stop(){if(recorder&&recorder.state!=="inactive") recorder.stop()}

async function finish(){
  clearInterval(timer);
  const length=(pausedAt??Date.now())-startedAt-totalPaused;
  for(const s of [display,mic]) s?.getTracks().forEach(t=>t.stop());
  audioCtx?.close();
  $("#controls").classList.add("hidden");
  $("#wave").classList.add("paused");
  $("#status").textContent="Saving…";
  await chrome.storage.local.set({...IDLE,saving:true});
  try{const w=await chrome.windows.getCurrent();await chrome.windows.update(w.id,{state:"normal",focused:true})}catch{}

  const blob=new Blob(chunks,{type:format.type});
  const url=URL.createObjectURL(blob);
  const name=`Screen Recording ${stamp()}.${format.ext}`;
  const {driveConnected}=await chrome.storage.local.get("driveConnected");
  const uploading=driveConnected&&settings.autoUpload;
  // Link first: "sharing" (creating the Drive file + link) → "uploading" with the link already usable → "uploaded".
  const id=await addHistory({kind:"recording",name,size:blob.size,duration:length,thumb,status:uploading?"sharing":"saving",progress:0});

  // Serialise history writes so a late progress update can't overwrite the final status.
  let queue=Promise.resolve();
  const update=patch=>queue=queue.then(()=>updateHistory(id,patch)).catch(()=>{});
  let lastPct=0;
  const onProgress=p=>{
    const pct=Math.round(p*100);
    $("#progress i").style.width=`${pct}%`;
    $("#sub").textContent=`Uploading to Google Drive… ${pct}%`;
    if(pct-lastPct>=5||pct===100){lastPct=pct;update({progress:pct})}
  };
  if(uploading){
    $("#status").textContent="Generating share link…";
    $("#sub").textContent="Creating your Google Drive link…";
    msg("Keep this window open until the upload finishes.");
    showCard(id);
  }else msg("Saving recording…");
  const onLink=async({fileId,driveUrl,share})=>{
    await update({status:"uploading",fileId,driveUrl,...share});
    $("#progress").classList.remove("hidden");
    $("#status").textContent=share.shared?"Link ready — uploading…":"Uploading…";
    $("#sub").textContent="Uploading to Google Drive…";
  };

  try{
    const r=await saveFile({blob,url,name,mimeType:format.type,kind:"recordings",onProgress,onLink});
    if(r.where==="drive"){
      await update({status:r.share.shared?"uploaded":"share_failed",progress:100,downloadId:r.downloadId});
      const e=await showCard(id);
      $("#status").textContent=e?.status==="uploaded"?"Recording ready":"Uploaded";
      $("#sub").textContent="Uploaded to Google Drive";
      msg("You can close this window. The link is also saved in History.","ok");
    }else{
      await update({status:"local",progress:100,downloadId:r.downloadId,error:r.warning,fileId:null,driveUrl:null,shared:false,webViewLink:null});
      $("#shareSlot").innerHTML="";
      $("#status").textContent="Done";
      $("#sub").textContent="Saved to Downloads";
      if(r.warning) msg(r.warning,"error");
      else msg("Recording saved to your Downloads folder. You can close this window.","ok");
    }
  }catch(e){
    await update({status:"failed",error:e.message});
    $("#status").textContent="Failed";
    msg(`Could not save recording: ${e.message}`,"error");
  }
  $("#progress").classList.add("hidden");
  // Done with this window: the next Record click opens a fresh recorder.
  await chrome.storage.local.set({saving:false,recorderWindowId:null});
  recorder=null;display=null;mic=null;chunks=[];
}

// Result card for this recording; stays in sync with History (e.g. after Retry Link).
let card=null;
async function showCard(id){
  card=(await getHistory()).find(x=>x.id===id)||null;
  $("#shareSlot").innerHTML=card?shareCard(card,{dismissible:false}):"";
  return card;
}
chrome.storage.onChanged.addListener((c,area)=>{if(area==="local"&&c.history&&card) showCard(card.id)});
bindShareActions($("#shareSlot"),{
  find:id=>card?.id===id?card:null,
  notify:t=>msg(t,"ok"),
  fail:(t,x)=>msg(x?`${t} ${x}`:t,"error"),
  openDrive:e=>chrome.tabs.create({url:driveFileUrl(e)}),
});

chrome.runtime.onMessage.addListener((m,s,send)=>{
  if(m?.type==="REC_PAUSE"){togglePause().then(()=>send({ok:true}));return true}
  if(m?.type==="REC_STOP"){stop();send({ok:true});return false}
  return false;
});
$("#pause").onclick=togglePause;
$("#stop").onclick=stop;
window.addEventListener("beforeunload",e=>{if(recorder){e.preventDefault()}});

fillIcons();
$("#wave").innerHTML=waveBars();
getSettings().then(s=>{if(s.theme!=="system") document.documentElement.dataset.theme=s.theme});
start();
