// "Recording ready / Screenshot ready" card and the Copy Link / Share / Open / Retry Link actions,
// shared by the popup and the recorder window.
import {ICONS,clock,pad} from "./icons.js";

export const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
export function size(b){
  if(!b) return "";
  const u=["B","KB","MB","GB"];let i=0;while(b>=1024&&i<u.length-1){b/=1024;i++}
  return `${b.toFixed(i>1?1:0)} ${u[i]}`;
}
export const duration=ms=>{const s=Math.round(ms/1000);return s>=3600?clock(ms):`${pad(Math.floor(s/60))}:${pad(s%60)}`};

// A shareable item is one whose public permission was created by this extension. The link exists
// before the upload finishes (link-first), so it is usable while "uploading" as well as once "uploaded".
export const hasShareLink=e=>(e?.status==="uploaded"||e?.status==="uploading")&&!!e.shared&&!!e.webViewLink;
export const SHARE_FAILED="File uploaded, but share link could not be generated.";
export const SHARE_BLOCKED="Your Google Drive account does not allow public link sharing.";

const what=e=>e.kind==="recording"?"Recording":"Screenshot";

// Buttons for an item; used in the card and in History rows.
export function shareActions(e,{compact=false}={}){
  const id=esc(e.id);
  if(hasShareLink(e)) return `<div class="share-actions${compact?" compact":""}">
    <button class="btn btn-primary btn-sm" data-act="copy" data-id="${id}"><span class="ico-sm" data-i="link">${ICONS.link}</span><span data-label>Copy Link</span></button>
    <button class="btn btn-outline btn-sm" data-act="share" data-id="${id}"><span class="ico-sm">${ICONS.share}</span><span>Share</span></button>
    <button class="btn btn-outline btn-sm" data-act="open" data-id="${id}"><span class="ico-sm">${ICONS.external}</span><span>Open</span></button></div>`;
  if(e.status==="share_failed") return `<div class="share-actions${compact?" compact":""}">
    <button class="btn btn-outline btn-sm" data-act="drive" data-id="${id}"><span class="ico-sm">${ICONS.drive}</span><span>Open Drive</span></button>
    ${e.sharePolicy?"":`<button class="btn btn-primary btn-sm" data-act="retry" data-id="${id}"><span class="ico-sm">${ICONS.retry}</span><span>Retry Link</span></button>`}</div>`;
  return "";
}

export function shareCard(e,{dismissible=true}={}){
  const meta=[size(e.size),e.duration?duration(e.duration):""].filter(Boolean).join(" • ");
  const close=dismissible?`<button class="card-x" data-act="dismiss" data-id="${esc(e.id)}" aria-label="Dismiss">${ICONS.x}</button>`:"";
  let icon,title,body="",foot="";
  if(e.status==="uploading"){
    const linked=hasShareLink(e);
    icon=linked?`<span class="sc-ico ok">${ICONS.link}</span>`:`<span class="sc-ico busy"><i class="mini-spin"></i></span>`;
    title=linked?`Link ready — uploading ${e.progress||0}%`:`Uploading… ${e.progress||0}%`;
    body=`<div class="bar"><i style="width:${e.progress||0}%"></i></div>`;
    if(linked) foot=`<p class="sc-foot"><span class="ico-sm">${ICONS.globe}</span>Share it now — it opens once the upload finishes</p>`;
  }else if(e.status==="sharing"){
    icon=`<span class="sc-ico busy"><i class="mini-spin"></i></span>`;title="Generating share link…";
  }else if(hasShareLink(e)){
    icon=`<span class="sc-ico ok">${ICONS.check}</span>`;title=`${what(e)} ready`;
    foot=`<p class="sc-foot"><span class="ico-sm">${ICONS.globe}</span>Anyone with the link can view</p>`;
  }else if(e.status==="share_failed"){
    icon=`<span class="sc-ico warn">${ICONS.alert}</span>`;title=e.sharePolicy?SHARE_BLOCKED:SHARE_FAILED;
    foot=`<p class="sc-foot muted" title="${esc(e.shareError||"")}">Your file is safe in Google Drive.</p>`;
  }else return "";
  return `<section class="card share-card" data-status="${esc(e.status)}">
    <div class="sc-head">${icon}<strong>${esc(title)}</strong>${close}</div>
    <div class="sc-file"><span class="sc-name">${esc(e.name)}</span>${meta?`<small>${esc(meta)}</small>`:""}</div>
    ${body}${shareActions(e)}${foot}</section>`;
}

// Wires data-act buttons inside root. find(id) returns the history entry.
export function bindShareActions(root,{find,notify,fail,dismiss,openDrive}){
  root.addEventListener("click",async ev=>{
    const b=ev.target.closest("[data-act]");
    if(!b||!root.contains(b)) return;
    ev.stopPropagation();
    const e=find(b.dataset.id);
    if(!e&&b.dataset.act!=="dismiss") return;
    switch(b.dataset.act){
      case "copy":{
        try{
          await navigator.clipboard.writeText(e.webViewLink);
          const ico=b.querySelector("[data-i]"),label=b.querySelector("[data-label]");
          if(label) label.textContent="Copied";
          ico.innerHTML=ICONS.check;b.classList.add("copied");
          setTimeout(()=>{if(label) label.textContent="Copy Link";ico.innerHTML=ICONS.link;b.classList.remove("copied")},1600);
          notify("Link copied","Anyone with the link can view.");
        }catch{fail("Couldn't copy the link","Your browser blocked clipboard access. Use Open and copy the link from Drive.")}
        break;
      }
      case "share":openShareMenu(b,e,{notify,fail});break;
      case "open":
        try{await chrome.tabs.create({url:e.webViewLink})}catch(err){fail("Couldn't open the link",err.message)}
        break;
      case "drive":
        try{await openDrive(e)}catch(err){fail("Couldn't open Google Drive",err.message)}
        break;
      case "retry":{
        b.disabled=true;
        try{
          const r=await chrome.runtime.sendMessage({type:"RETRY_LINK",id:e.id});
          if(r?.error) throw new Error(r.error);
          if(r.status==="uploaded") notify("Share link ready","Anyone with the link can view.");
          else fail(r.sharePolicy?SHARE_BLOCKED:SHARE_FAILED,r.shareError||"");
        }catch(err){fail(SHARE_FAILED,err.message)}
        finally{b.disabled=false}
        break;
      }
      case "dismiss":dismiss?.(b.dataset.id);break;
    }
  });
}

// ---------- Share menu ----------
const SHARE_TARGETS=[
  ["chat","WhatsApp",(l,t)=>`https://wa.me/?text=${encodeURIComponent(`${t} ${l}`)}`],
  ["send","Telegram",(l,t)=>`https://t.me/share/url?url=${encodeURIComponent(l)}&text=${encodeURIComponent(t)}`],
  ["mail","Gmail",(l,t)=>`https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(t)}&body=${encodeURIComponent(l)}`],
  ["mail","Email app",(l,t)=>`mailto:?subject=${encodeURIComponent(t)}&body=${encodeURIComponent(l)}`],
];
let shareMenu=null;
function closeShareMenu(){shareMenu?.remove();shareMenu=null}
document.addEventListener("click",ev=>{if(shareMenu&&!shareMenu.contains(ev.target)&&!ev.target.closest('[data-act="share"]')) closeShareMenu()});
document.addEventListener("keydown",ev=>{if(ev.key==="Escape") closeShareMenu()});

function openShareMenu(btn,e,{notify,fail}){
  if(shareMenu){closeShareMenu();return}
  const title=e.kind==="recording"?"Screen recording":"Screenshot";
  const items=SHARE_TARGETS.map(([ic,label,make])=>[ic,label,()=>chrome.tabs.create({url:make(e.webViewLink,title)})]);
  // The system share sheet, where this Chrome supports it.
  if(navigator.share) items.push(["share","More options…",()=>navigator.share({title,text:title,url:e.webViewLink})]);
  shareMenu=document.createElement("div");
  shareMenu.className="menu";shareMenu.setAttribute("role","menu");
  shareMenu.innerHTML=items.map(([ic,label],i)=>`<button data-i="${i}" role="menuitem"><span>${ICONS[ic]}</span>${label}</button>`).join("");
  shareMenu.querySelectorAll("button").forEach(b=>b.onclick=async ev=>{
    ev.stopPropagation();const [,label,run]=items[b.dataset.i];closeShareMenu();
    try{await run()}catch(err){if(err?.name!=="AbortError") fail(`Couldn't open ${label}`,err.message)}
  });
  document.body.appendChild(shareMenu);
  const r=btn.getBoundingClientRect();
  const below=r.bottom+4+shareMenu.offsetHeight<=window.innerHeight;
  shareMenu.style.top=`${below?r.bottom+4:Math.max(8,r.top-4-shareMenu.offsetHeight)}px`;
  shareMenu.style.left=`${Math.min(Math.max(8,r.left),window.innerWidth-shareMenu.offsetWidth-8)}px`;
}

// Icon-only copy button for compact lists.
export const miniCopy=e=>hasShareLink(e)?`<button class="mini-act" data-act="copy" data-id="${esc(e.id)}" title="Copy link" aria-label="Copy link"><span data-i="link">${ICONS.link}</span></button>`:"";

// Owner-only Drive view of the file (works without the public permission), else the Drive home.
export const driveFileUrl=e=>e?.driveUrl||(e?.fileId?`https://drive.google.com/file/d/${encodeURIComponent(e.fileId)}/view`:"https://drive.google.com/drive/my-drive");
