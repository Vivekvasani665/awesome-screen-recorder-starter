const $=s=>document.querySelector(s);
const msg=(t,type="")=>{const e=$("#message");e.textContent=t;e.className=`message ${type}`};
async function send(type,data={}){
  const r=await chrome.runtime.sendMessage({type,...data});
  if(r?.error) throw new Error(r.error);
  return r;
}
const format=n=>{n=Math.max(0,Math.floor(n/1000));return `${String(Math.floor(n/60)).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`};
async function refresh(){
  const s=await send("GET_STATE");
  $("#driveStatus").textContent=s.connected?"Connected":"Not connected (saves to Downloads)";
  $("#connect").classList.toggle("hidden",!!s.connected);
  $("#record").disabled=!!s.recording;
  $("#screenshot").disabled=!!s.recording;
  $("#recordingControls").classList.toggle("hidden",!s.recording);
  $("#pause").textContent=s.paused?"Resume":"Pause";
  $("#status").textContent=s.recording?(s.paused?"Paused":"Recording…"):"Ready";
  if(s.recording&&s.startedAt) $("#timer").textContent=format((s.paused?s.pausedAt:Date.now())-s.startedAt-(s.totalPaused||0));
}
$("#connect").onclick=async()=>{try{msg("Connecting…");await send("CONNECT_DRIVE");msg("Google Drive connected","ok");await refresh()}catch(e){msg(e.message,"error")}};
$("#record").onclick=async()=>{try{await send("START_RECORDING");window.close()}catch(e){msg(e.message,"error")}};
$("#screenshot").onclick=async()=>{
  try{
    msg("Capturing screenshot…");
    const r=await send("SCREENSHOT");
    if(r.warning) msg(r.warning,"error");
    else msg(r.where==="drive"?"Screenshot uploaded to Google Drive":"Screenshot saved to Downloads","ok");
  }catch(e){msg(e.message,"error")}
};
$("#pause").onclick=async()=>{try{await chrome.runtime.sendMessage({type:"REC_PAUSE"});await refresh()}catch(e){msg("Recorder window not found.","error")}};
$("#stop").onclick=async()=>{try{await chrome.runtime.sendMessage({type:"REC_STOP"});msg("Stopping… the recorder window will show when it's saved.","ok")}catch(e){msg("Recorder window not found.","error")}};
$("#settings").onclick=()=>chrome.runtime.openOptionsPage();
setInterval(()=>refresh().catch(()=>{}),500);refresh().catch(e=>msg(e.message,"error"));
