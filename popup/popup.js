import {ICONS,fillIcons,waveBars,clock} from "./icons.js";
import {getSettings,saveSettings} from "../lib/settings.js";
import {removeHistory} from "../lib/history.js";
import {esc,size,duration,hasShareLink,shareCard,shareActions,miniCopy,bindShareActions,driveFileUrl} from "./share-card.js";

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const CARD_MAX_AGE=60*60*1000; // the main view's result card shows the latest upload for up to an hour
const isPage=new URLSearchParams(location.search).get("view")==="settings"; // opened as the options page

let S={};            // chrome.storage.local snapshot
let settings={};
let view=isPage?"settings":"main";
let historyTab="recording";
let toastTimer=null;

async function send(type,data={}){
  const r=await chrome.runtime.sendMessage({type,...data});
  if(r?.error) throw new Error(r.error);
  return r;
}

// ---------- formatting ----------
function ago(t){
  const s=Math.round((Date.now()-t)/1000);
  if(s<45) return "Just now";
  const m=Math.round(s/60); if(m<60) return `${m} minute${m>1?"s":""} ago`;
  const h=Math.round(m/60); if(h<24) return `${h} hour${h>1?"s":""} ago`;
  const d=Math.round(h/24); return d<7?`${d} day${d>1?"s":""} ago`:new Date(t).toLocaleDateString();
}
const date=t=>new Date(t).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});

function activityTitle(e){
  const what=e.kind==="recording"?"Recording":"Screenshot";
  return {uploaded:hasShareLink(e)?`${what} ready`:`${what} uploaded`,local:`${what} saved`,uploading:hasShareLink(e)?`Link ready — uploading ${e.progress||0}%`:`Uploading ${what.toLowerCase()}… ${e.progress||0}%`,
    sharing:"Generating share link…",share_failed:e.sharePolicy?"Uploaded — public sharing blocked":"Uploaded — link not generated",
    saving:`Saving ${what.toLowerCase()}…`,failed:`${what} failed`}[e.status]||what;
}
const pillText=e=>({uploaded:hasShareLink(e)?"Uploaded ✓":"Uploaded",local:"Saved locally",uploading:`Uploading ${e.progress||0}%`,
  sharing:"Generating link…",share_failed:e.sharePolicy?"Sharing blocked":"Link failed",saving:"Saving…",failed:"Failed"})[e.status]||"";

// ---------- toast / banner ----------
function toast(title,text){
  $("#toastTitle").textContent=title;$("#toastText").textContent=text||"";
  $("#toast").classList.remove("hidden");
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>$("#toast").classList.add("hidden"),4000);
}
function banner(title,text){
  $("#bannerTitle").textContent=title;$("#bannerText").textContent=text||"";
  $("#banner").classList.remove("hidden");
}
const hideBanner=()=>$("#banner").classList.add("hidden");
$(".toast-close").onclick=()=>$("#toast").classList.add("hidden");
$(".banner-close").onclick=hideBanner;

// ---------- rendering ----------
function applyAppearance(){
  if(settings.theme==="system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme=settings.theme;
  document.body.classList.toggle("compact",!!settings.compact);
}

function go(v){view=v;closeMenu();render();window.scrollTo(0,0)}

function render(){
  const current=view==="main"&&S.recording?"recording":view;
  for(const v of ["main","recording","capturing","settings","history"]) $(`#view-${v}`).classList.toggle("hidden",v!==current);
  document.body.classList.toggle("recording",current==="recording");
  if(current==="main") renderMain();
  if(current==="recording") renderRecording();
  if(current==="capturing") renderCapturing();
  if(current==="settings") renderSettings();
  if(current==="history") renderHistory();
}

function renderMain(){
  const connected=!!S.driveConnected;
  $(".drive").classList.toggle("connected",connected);
  $("#driveStatus").textContent=connected?"Connected":"Not connected";
  $("#driveEmail").textContent=S.driveEmail||"";
  $("#driveEmail").classList.toggle("hidden",!connected||!S.driveEmail);
  $("#driveHint").textContent=!connected?"Save your recordings and screenshots directly to Google Drive."
    :settings.autoUpload?"Files are saved automatically to Google Drive.":"Auto upload is off — files are saved to Downloads.";
  $("#connect").classList.toggle("hidden",connected);
  $("#openDrive").classList.toggle("hidden",!connected);

  const picking=!!S.recorderWindowId&&!S.recording&&!S.saving;
  $("#record").disabled=!!S.saving;
  $("#record strong").textContent=S.saving?"Saving recording…":picking?"Choose what to record…":"Record Screen";
  $("#record small").textContent=S.saving?"Wait for the upload to finish":picking?"Finish in the recorder window":"Capture your screen";

  const latest=(S.history||[])[0];
  const showCard=latest&&(latest.fileId||latest.status==="uploading")&&latest.id!==S.dismissedCard&&Date.now()-latest.createdAt<CARD_MAX_AGE;
  $("#shareSlot").innerHTML=showCard?shareCard(latest):"";

  const items=(S.history||[]).slice(0,3);
  $("#recentList").innerHTML=items.length?items.map(e=>`
    <li data-id="${esc(e.id)}" title="${esc(e.error||e.shareError||e.name)}">
      <span class="a-ico${e.status==="failed"?" failed":""}">${ICONS[e.kind==="recording"?"video":"image"]}</span>
      <div style="flex:1;min-width:0"><strong>${esc(activityTitle(e))}</strong><small>${esc(ago(e.createdAt))}</small></div>${miniCopy(e)}
    </li>`).join("")
    :`<li class="empty" style="cursor:default"><div style="width:100%"><strong>No recent activity</strong>Your recordings and screenshots will appear here.</div></li>`;
}

const SURFACE={screen:["Screen","Entire screen"],window:["Window","Application window"],tab:["Tab","Browser tab"]};
function renderRecording(){
  const info=S.recInfo||{};
  const [name,sub]=SURFACE[info.surface]||SURFACE.screen;
  $("#recStatus").textContent=S.paused?"Paused":"Recording…";
  $("#recSub").textContent=S.paused?"Recording paused":`Recording your ${name.toLowerCase()}`;
  $("#recWave").classList.toggle("paused",!!S.paused);
  $("#pause span:last-child").textContent=S.paused?"Resume":"Pause";
  $("#pause .ico-sm").innerHTML=ICONS[S.paused?"play":"pause"];
  $("#infoSurface").textContent=name;$("#infoSurfaceSub").textContent=sub;
  $("#infoMic").textContent=info.mic?"On":"Off";
  $("#infoAudio").textContent=info.systemAudio?"On":"Off";
  tick();
}
const SHOT_STAGE={sharing:["Generating share link…","Creating your Google Drive link before uploading."],uploading:["Uploading screenshot…","Saving your screenshot to Google Drive."]};
function renderCapturing(){
  const [t,x]=SHOT_STAGE[S.shotStage]||["Capturing screenshot…","Please wait while we capture your current tab."];
  $("#view-capturing h2").textContent=t;$("#view-capturing .capture p").textContent=x;
}
function tick(){
  if(!S.recording||!S.startedAt) return;
  $("#recTimer").textContent=clock((S.paused?S.pausedAt:Date.now())-S.startedAt-(S.totalPaused||0));
}

function renderSettings(){
  for(const el of $$("[data-setting]")){
    const v=settings[el.dataset.setting];
    if(el.type==="checkbox") el.checked=!!v; else el.value=String(v);
  }
  const fp=$("#folderPrefix");
  if(document.activeElement!==fp) fp.value=S.folderPrefix||"";
  const t=$("#driveToggle");
  t.textContent=S.driveConnected?"Disconnect":"Connect";
  t.classList.toggle("off",!S.driveConnected);
  t.title=S.driveConnected?(S.driveEmail?`Connected as ${S.driveEmail}`:"Connected"):"Not connected";
}

function renderHistory(){
  const shareHandlers={find:findItem,notify:toast,fail:banner,
  dismiss:id=>chrome.storage.local.set({dismissedCard:id}),
  openDrive:e=>chrome.tabs.create({url:driveFileUrl(e)})};
bindShareActions($("#view-main"),shareHandlers);
bindShareActions($("#view-history"),{...shareHandlers,fail:(t,x)=>{go("main");banner(t,x)}});
$$(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===historyTab));
  const items=(S.history||[]).filter(e=>e.kind===historyTab);
  $("#historyList").innerHTML=items.length?items.map(e=>{
    const meta=[date(e.createdAt),size(e.size),e.duration?duration(e.duration):""].filter(Boolean).join(" • ");
    const thumb=e.thumb?`<img class="thumb" src="${esc(e.thumb)}" alt="">`
      :`<span class="thumb thumb-ph"><span>${ICONS[e.kind==="recording"?"video":"image"]}</span></span>`;
    const bar=e.status==="uploading"?`<div class="bar" style="width:100%"><i style="width:${e.progress||0}%"></i></div>`:"";
    return `<li data-id="${esc(e.id)}" title="${esc(e.error||e.shareError||"")}">${thumb}
      <div class="h-body"><strong style="max-width:100%">${esc(e.name)}</strong><small>${esc(meta)}</small><span class="pill ${esc(e.status)}">${esc(pillText(e))}</span>${bar}${shareActions(e,{compact:true})}</div>
      <button class="more" data-menu="${esc(e.id)}" aria-label="More actions">${ICONS.more}</button></li>`;
  }).join("")
  :`<li class="empty" style="cursor:default;border:0"><div style="width:100%"><strong>No ${historyTab==="recording"?"recordings":"screenshots"} yet</strong>They will appear here after you capture them.</div></li>`;
}

// ---------- item actions ----------
const findItem=id=>(S.history||[]).find(e=>e.id===id);
async function openItem(e){
  if(!e) return;
  if(e.fileId||e.webViewLink) return chrome.tabs.create({url:hasShareLink(e)?e.webViewLink:e.webViewLink||driveFileUrl(e)});
  if(e.downloadId!=null){try{chrome.downloads.show(e.downloadId);return}catch{}}
  if(e.error) banner(e.status==="failed"?"Save failed":"Upload failed",e.error);
}

function closeMenu(){$("#menu").classList.add("hidden")}
function openMenu(btn,e){
  const opts=[];
  if(e.fileId||e.webViewLink) opts.push(["external","Open in Google Drive",()=>chrome.tabs.create({url:e.webViewLink||driveFileUrl(e)})]);
  if(e.downloadId!=null) opts.push(["folder","Show in folder",()=>chrome.downloads.show(e.downloadId)]);
  opts.push(["trash","Remove from history",()=>removeHistory(e.id),"danger"]);
  const m=$("#menu");
  m.innerHTML=opts.map(([ic,label,,cls],i)=>`<button data-i="${i}" class="${cls||""}"><span>${ICONS[ic]}</span>${label}</button>`).join("");
  m.querySelectorAll("button").forEach(b=>b.onclick=ev=>{ev.stopPropagation();closeMenu();opts[b.dataset.i][2]()});
  m.classList.remove("hidden");
  const r=btn.getBoundingClientRect();
  m.style.top=`${Math.min(r.bottom+4,window.innerHeight-m.offsetHeight-8)}px`;
  m.style.left=`${Math.max(8,r.right-m.offsetWidth)}px`;
}

// ---------- events ----------
document.addEventListener("click",ev=>{
  const goBtn=ev.target.closest("[data-go]");
  if(goBtn){go(goBtn.dataset.go);return}
  if(!ev.target.closest("#menu")) closeMenu();
});

$("#connect").onclick=async()=>{
  const b=$("#connect");b.disabled=true;b.lastElementChild.textContent="Connecting…";hideBanner();
  try{
    const r=await send("CONNECT_DRIVE");
    toast("Google Drive connected",r.email?`Signed in as ${r.email}`:"Files will be saved to your Drive.");
  }catch(e){banner("Google Drive connection failed",e.message||"Please try again or check your internet connection.")}
  finally{b.disabled=false;b.lastElementChild.textContent="Connect Google Drive"}
};
$("#openDrive").onclick=()=>chrome.tabs.create({url:S.rootFolderId?`https://drive.google.com/drive/folders/${S.rootFolderId}`:"https://drive.google.com/drive/my-drive"});

$("#record").onclick=async()=>{
  hideBanner();
  try{await send("START_RECORDING");if(!isPage) window.close()}
  catch(e){banner("Could not start recording",e.message)}
};

$("#screenshot").onclick=async()=>{
  hideBanner();go("capturing");
  try{
    const r=await send("SCREENSHOT");
    if(r.cancelled) return;
    if(view==="capturing") go("main");
    // Drive uploads are reported by the result card (ready / link failed) at the top of the main view.
    if(r.warning) banner("Google Drive upload failed",r.warning);
    else if(r.where!=="drive") toast("Screenshot saved","Saved to your Downloads folder.");
  }catch(e){
    if(view==="capturing") go("main");
    banner("Screenshot failed",e.message);
  }
};
$("#cancelShot").onclick=()=>{send("CANCEL_SCREENSHOT").catch(()=>{});go("main")};

$("#pause").onclick=()=>chrome.runtime.sendMessage({type:"REC_PAUSE"}).catch(()=>banner("Recorder window not found",""));
$("#stop").onclick=()=>chrome.runtime.sendMessage({type:"REC_STOP"}).catch(()=>banner("Recorder window not found",""));

$("#recentList").onclick=ev=>{if(ev.target.closest("[data-act]")) return;const li=ev.target.closest("li[data-id]");if(li) openItem(findItem(li.dataset.id))};
$("#historyList").onclick=ev=>{
  if(ev.target.closest("[data-act]")) return;
  const more=ev.target.closest("[data-menu]");
  if(more){ev.stopPropagation();openMenu(more,findItem(more.dataset.menu));return}
  const li=ev.target.closest("li[data-id]");if(li) openItem(findItem(li.dataset.id));
};
const shareHandlers={find:findItem,notify:toast,fail:banner,
  dismiss:id=>chrome.storage.local.set({dismissedCard:id}),
  openDrive:e=>chrome.tabs.create({url:driveFileUrl(e)})};
bindShareActions($("#view-main"),shareHandlers);
bindShareActions($("#view-history"),{...shareHandlers,fail:(t,x)=>{go("main");banner(t,x)}});
$$(".tab").forEach(t=>t.onclick=()=>{historyTab=t.dataset.tab;renderHistory()});

for(const el of $$("[data-setting]")){
  el.onchange=async()=>{
    const k=el.dataset.setting;
    const v=el.type==="checkbox"?el.checked:"num" in el.dataset?Number(el.value):el.value;
    settings=await saveSettings({[k]:v});
    applyAppearance();
  };
}
const saveFolder=async()=>{
  const v=$("#folderPrefix").value.trim();
  // Drive folder ids are looked up by name on every upload; the cached root id only powers "Open Drive".
  if(v!==(S.folderPrefix||"")) await chrome.storage.local.set({folderPrefix:v,rootFolderId:null});
};
$("#folderPrefix").onchange=saveFolder;
$("#folderPrefix").onkeydown=e=>{if(e.key==="Enter") e.target.blur()};
$("#driveToggle").onclick=async()=>{
  const b=$("#driveToggle");b.disabled=true;
  try{
    if(S.driveConnected){await send("DISCONNECT_DRIVE");toast("Google Drive disconnected","Files will be saved to Downloads.")}
    else{const r=await send("CONNECT_DRIVE");toast("Google Drive connected",r.email?`Signed in as ${r.email}`:"")}
  }catch(e){go("main");banner("Google Drive connection failed",e.message)}
  finally{b.disabled=false}
};

// ---------- boot ----------
const KEYS=["shotStage","dismissedCard","recording","saving","paused","startedAt","pausedAt","totalPaused","recorderWindowId","recInfo","driveConnected","driveEmail","rootFolderId","folderPrefix","history"];
async function load(){S=await chrome.storage.local.get(KEYS);settings=await getSettings()}

chrome.storage.onChanged.addListener(async(changes,area)=>{
  if(area!=="local") return;
  await load();applyAppearance();
  // Link first: as soon as the screenshot's link exists, show it (with Copy/Share) while the upload finishes.
  if(view==="capturing"&&S.shotStage==="uploading") view="main";
  if(view==="history"&&!$("#menu").classList.contains("hidden")) return; // don't re-render under an open menu
  render();
});

fillIcons();
$("#recWave").innerHTML=waveBars();
$$(".version").forEach(e=>e.textContent=`v${chrome.runtime.getManifest().version}`);
if(isPage) document.body.classList.add("page");
// MP4 recording is only offered where this Chrome's MediaRecorder supports it.
if(!["video/mp4;codecs=avc1,mp4a.40.2","video/mp4"].some(t=>MediaRecorder.isTypeSupported(t))){
  const o=$('[data-setting="format"] option[value="mp4"]');o.disabled=true;o.textContent="MP4 (not supported)";
}
await load();applyAppearance();render();
setInterval(()=>{if(S.recording&&view==="main") tick()},500);
