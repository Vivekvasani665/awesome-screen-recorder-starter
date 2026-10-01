// Shared Google Drive + local-save helpers (used by background and recorder page).
import {getSettings} from "./settings.js";

const DEFAULT_ROOT="Awesome Screen Recorder";
const REC="Recordings";
const SHOTS="Screenshots";

export function clientIdConfigured(){
  const id=chrome.runtime.getManifest().oauth2?.client_id||"";
  return !!id && !id.startsWith("YOUR_");
}

export async function getToken(interactive=true){
  if(!clientIdConfigured()) throw new Error("Google Drive is not set up: put your OAuth client ID in manifest.json (see README).");
  const r=await chrome.identity.getAuthToken({interactive});
  if(!r?.token) throw new Error("Google authorization failed.");
  return r.token;
}

async function driveFetch(url,options={}){
  let token=await getToken(true);
  const go=t=>fetch(url,{...options,headers:{Authorization:`Bearer ${t}`,...(options.headers||{})}});
  let res=await go(token);
  if(res.status===401){await chrome.identity.removeCachedAuthToken({token});token=await getToken(true);res=await go(token)}
  if(!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
  return res;
}

async function findOrCreateFolder(name,parentId="root",signal){
  const q=`name='${name.replaceAll("\\","\\\\").replaceAll("'","\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
  const r=await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1&fields=files(id,name)`,{signal});
  const data=await r.json(); if(data.files?.[0]) return data.files[0].id;
  const create=await driveFetch("https://www.googleapis.com/drive/v3/files",{method:"POST",signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({name,mimeType:"application/vnd.google-apps.folder",parents:[parentId]})});
  return (await create.json()).id;
}

export async function getFolders(signal){
  const {folderPrefix}=await chrome.storage.local.get("folderPrefix");
  const root=await findOrCreateFolder(folderPrefix||DEFAULT_ROOT,"root",signal);
  const recordings=await findOrCreateFolder(REC,root,signal);
  const screenshots=await findOrCreateFolder(SHOTS,root,signal);
  return {root,recordings,screenshots};
}

export async function getAccountEmail(){
  const r=await driveFetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)");
  return (await r.json()).user?.emailAddress||"";
}

// Uses XMLHttpRequest when available (pages) so upload progress can be reported; service workers fall back to fetch.
function putSession(session,blob,mimeType,{signal,onProgress}){
  if(!onProgress||typeof XMLHttpRequest==="undefined"){
    return fetch(session,{method:"PUT",headers:{"Content-Type":mimeType},body:blob,signal}).then(async put=>{
      if(!put.ok) throw new Error(`Upload ${put.status}: ${await put.text()}`);
      return put.json();
    });
  }
  return new Promise((resolve,reject)=>{
    const x=new XMLHttpRequest();
    x.open("PUT",session);
    x.setRequestHeader("Content-Type",mimeType);
    x.responseType="json";
    x.upload.onprogress=e=>{if(e.lengthComputable) onProgress(e.loaded/e.total)};
    x.onload=()=>x.status>=200&&x.status<300?resolve(x.response||{}):reject(new Error(`Upload ${x.status}`));
    x.onerror=()=>reject(new Error("Network error during upload"));
    x.onabort=()=>reject(new DOMException("Cancelled","AbortError"));
    signal?.addEventListener("abort",()=>x.abort());
    x.send(blob);
  });
}

async function uploadBlob(blob,name,mimeType,folderId,opts={}){
  const init=await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",{method:"POST",signal:opts.signal,headers:{
    "Content-Type":"application/json; charset=UTF-8",
    "X-Upload-Content-Type":mimeType,"X-Upload-Content-Length":String(blob.size)
  },body:JSON.stringify({name,mimeType,parents:[folderId]})});
  const session=init.headers.get("Location");
  if(!session) throw new Error("Drive did not return an upload session URL.");
  return putSession(session,blob,mimeType,opts);
}

// url: a data: URL or blob: URL. Returns the download id.
export async function saveLocally(url,name){
  const {folderPrefix}=await chrome.storage.local.get("folderPrefix");
  const dir=(folderPrefix||DEFAULT_ROOT).replace(/[\\/:*?"<>|]/g,"_");
  return chrome.downloads.download({url,filename:`${dir}/${name}`,saveAs:false});
}

// Uploads to Drive when connected and auto upload is on; otherwise (or if upload fails) saves to Downloads.
// kind: "recordings" | "screenshots". Returns {where:"drive"|"local", webViewLink?, downloadId?, warning?}
export async function saveFile({blob,url,name,mimeType,kind,signal,onProgress}){
  const {driveConnected}=await chrome.storage.local.get("driveConnected");
  const {autoUpload,keepLocal}=await getSettings();
  if(driveConnected&&autoUpload){
    try{
      const f=await getFolders(signal);
      const file=await uploadBlob(blob,name,mimeType,f[kind],{signal,onProgress});
      const downloadId=keepLocal?await saveLocally(url,name):undefined;
      return {where:"drive",webViewLink:file.webViewLink,downloadId};
    }catch(e){
      if(e.name==="AbortError") throw e;
      return {where:"local",downloadId:await saveLocally(url,name),warning:`Drive upload failed (${e.message}). Saved to Downloads instead.`};
    }
  }
  signal?.throwIfAborted();
  return {where:"local",downloadId:await saveLocally(url,name)};
}
