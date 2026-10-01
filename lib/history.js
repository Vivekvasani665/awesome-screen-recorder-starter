// Recent recordings/screenshots shown in the popup's Recent Activity and History views.
// Entry: {id, kind:"recording"|"screenshot", name, size, duration?, thumb?, createdAt,
//         status:"uploading"|"sharing"|"uploaded"|"share_failed"|"saving"|"local"|"failed", progress?,
//         fileId?, driveUrl? (owner-only Drive view), webViewLink?/resourceKey? (public link, set once shared:true),
//         shareError?, sharePolicy? (Drive forbids "anyone" links), downloadId?, error?}
const KEY="history";
const MAX=50;

export async function getHistory(){
  return (await chrome.storage.local.get(KEY))[KEY]||[];
}

export async function addHistory(entry){
  const e={id:crypto.randomUUID(),createdAt:Date.now(),...entry};
  await chrome.storage.local.set({[KEY]:[e,...await getHistory()].slice(0,MAX)});
  return e.id;
}

export async function updateHistory(id,patch){
  const h=await getHistory();
  const i=h.findIndex(e=>e.id===id);
  if(i<0) return;
  h[i]={...h[i],...patch};
  await chrome.storage.local.set({[KEY]:h});
}

export async function removeHistory(id){
  await chrome.storage.local.set({[KEY]:(await getHistory()).filter(e=>e.id!==id)});
}

// Small JPEG data URL from anything drawImage accepts (ImageBitmap, <video>, …).
export async function makeThumb(src,width,height){
  const W=160,H=Math.max(1,Math.round(W*height/width))||90;
  const c=new OffscreenCanvas(W,H);
  c.getContext("2d").drawImage(src,0,0,W,H);
  const bytes=new Uint8Array(await (await c.convertToBlob({type:"image/jpeg",quality:.7})).arrayBuffer());
  let s="";for(const b of bytes) s+=String.fromCharCode(b);
  return `data:image/jpeg;base64,${btoa(s)}`;
}

// "2026-10-01 14-05-33" — safe for file names.
export function stamp(d=new Date()){
  const p=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
