import {saveFile} from "../lib/drive.js";

const $=s=>document.querySelector(s);
const msg=(t,type="")=>{const e=$("#message");e.textContent=t;e.className=`message ${type}`};
const format=n=>{n=Math.floor(n/1000);return `${String(Math.floor(n/60)).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`};
const IDLE={recording:false,paused:false,startedAt:null,pausedAt:null,totalPaused:0};

let recorder=null,stream=null,chunks=[],startedAt=0,pausedAt=null,totalPaused=0,timer=null;
const mime=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(t=>MediaRecorder.isTypeSupported(t));

function pickSource(){
  return new Promise(resolve=>chrome.desktopCapture.chooseDesktopMedia(["screen","window","tab","audio"],(id,opts)=>resolve({id,audio:!!opts?.canRequestAudioTrack})));
}

async function getStream(id,audio){
  const src={mandatory:{chromeMediaSource:"desktop",chromeMediaSourceId:id}};
  try{return await navigator.mediaDevices.getUserMedia({video:src,audio:audio?src:false})}
  catch(e){if(audio) return navigator.mediaDevices.getUserMedia({video:src,audio:false});throw e}
}

async function start(){
  const {id,audio}=await pickSource();
  if(!id){await chrome.storage.local.set(IDLE);window.close();return}
  try{stream=await getStream(id,audio)}
  catch(e){
    msg(`Could not capture the screen: ${e.message}. On macOS, allow Chrome in System Settings → Privacy & Security → Screen Recording, then restart Chrome.`,"error");
    await chrome.storage.local.set(IDLE);return;
  }
  // User clicked Chrome's "Stop sharing" bar
  stream.getVideoTracks()[0].addEventListener("ended",stop);

  chunks=[];startedAt=Date.now();totalPaused=0;pausedAt=null;
  recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:4500000,audioBitsPerSecond:128000});
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  recorder.onstop=finish;
  recorder.start(1000);
  await chrome.storage.local.set({recording:true,paused:false,startedAt,pausedAt:null,totalPaused:0});

  $("#status").textContent="Recording…";
  $("#controls").classList.remove("hidden");
  msg("Recording. Use the extension popup or this window to pause/stop.");
  timer=setInterval(()=>{$("#timer").textContent=format((pausedAt??Date.now())-startedAt-totalPaused)},500);
  try{const w=await chrome.windows.getCurrent();await chrome.windows.update(w.id,{state:"minimized"})}catch{}
}

async function togglePause(){
  if(!recorder) return;
  if(recorder.state==="recording"){recorder.pause();pausedAt=Date.now()}
  else if(recorder.state==="paused"){recorder.resume();totalPaused+=Date.now()-pausedAt;pausedAt=null}
  const paused=recorder.state==="paused";
  $("#pause").textContent=paused?"Resume":"Pause";
  $("#status").textContent=paused?"Paused":"Recording…";
  await chrome.storage.local.set({paused,pausedAt,totalPaused});
}

function stop(){if(recorder&&recorder.state!=="inactive") recorder.stop()}

async function finish(){
  clearInterval(timer);
  stream?.getTracks().forEach(t=>t.stop());
  $("#controls").classList.add("hidden");
  $("#status").textContent="Saving…";
  try{const w=await chrome.windows.getCurrent();await chrome.windows.update(w.id,{state:"normal",focused:true})}catch{}
  const blob=new Blob(chunks,{type:"video/webm"});
  const url=URL.createObjectURL(blob);
  const name=`recording-${new Date().toISOString().replaceAll(":","-")}.webm`;
  msg("Saving recording…");
  try{
    const r=await saveFile({blob,url,name,mimeType:"video/webm",kind:"recordings"});
    $("#status").textContent="Done";
    if(r.warning) msg(r.warning,"error");
    else msg(r.where==="drive"?"Recording uploaded to Google Drive. You can close this window.":"Recording saved to your Downloads folder. You can close this window.","ok");
  }catch(e){
    $("#status").textContent="Failed";
    msg(`Could not save recording: ${e.message}`,"error");
  }
  await chrome.storage.local.set(IDLE);
  recorder=null;stream=null;chunks=[];
}

chrome.runtime.onMessage.addListener((m,s,send)=>{
  if(m?.type==="REC_PAUSE"){togglePause().then(()=>send({ok:true}));return true}
  if(m?.type==="REC_STOP"){stop();send({ok:true});return false}
  return false;
});
$("#pause").onclick=togglePause;
$("#stop").onclick=stop;
window.addEventListener("beforeunload",e=>{if(recorder){e.preventDefault()}});

start();
