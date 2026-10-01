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
  if(!res.ok){
    const text=await res.text();
    const err=new Error(`Drive API ${res.status}: ${text}`);
    err.status=res.status;
    try{const j=JSON.parse(text).error;err.reason=j?.errors?.[0]?.reason||j?.status||"";err.detail=j?.message||""}catch{}
    throw err;
  }
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

// opts.fileId: upload the content into an already-created (empty) Drive file instead of creating a new one.
async function uploadBlob(blob,name,mimeType,folderId,opts={}){
  const existing=opts.fileId?`/${encodeURIComponent(opts.fileId)}`:"";
  const init=await driveFetch(`https://www.googleapis.com/upload/drive/v3/files${existing}?uploadType=resumable&fields=id,webViewLink`,{method:existing?"PATCH":"POST",signal:opts.signal,headers:{
    "Content-Type":"application/json; charset=UTF-8",
    "X-Upload-Content-Type":mimeType,"X-Upload-Content-Length":String(blob.size)
  },body:JSON.stringify(existing?{}:{name,mimeType,parents:[folderId]})});
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

// Creates the (still empty) Drive file so its id — and therefore its share link — exists before the upload.
async function createDriveFile(name,mimeType,folderId,signal){
  const r=await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink",{method:"POST",signal,
    headers:{"Content-Type":"application/json"},body:JSON.stringify({name,mimeType,parents:[folderId]})});
  return r.json();
}

// Removes a placeholder file whose upload never completed, so a dead link doesn't stay in Drive.
export async function deleteDriveFile(fileId){
  await driveFetch(`${FILES}/${encodeURIComponent(fileId)}?supportsAllDrives=true`,{method:"DELETE"});
}

// Uploads to Drive when connected and auto upload is on; otherwise (or if upload fails) saves to Downloads.
// Link first: the Drive file is created and shared before its content is uploaded, and onLink({fileId,driveUrl,share})
// is called as soon as the link exists. kind: "recordings" | "screenshots".
// Returns {where:"drive"|"local", fileId?, driveUrl?, share?, downloadId?, warning?}
export async function saveFile({blob,url,name,mimeType,kind,signal,onProgress,onLink}){
  const {driveConnected}=await chrome.storage.local.get("driveConnected");
  const {autoUpload,keepLocal}=await getSettings();
  if(driveConnected&&autoUpload){
    let fileId=null;
    try{
      const f=await getFolders(signal);
      const file=await createDriveFile(name,mimeType,f[kind],signal);
      fileId=file.id;
      const share=await getShareLink(fileId);
      await onLink?.({fileId,driveUrl:file.webViewLink,share});
      await uploadBlob(blob,name,mimeType,f[kind],{signal,onProgress,fileId});
      const downloadId=keepLocal?await saveLocally(url,name):undefined;
      return {where:"drive",fileId,driveUrl:file.webViewLink,share,downloadId};
    }catch(e){
      if(fileId) await deleteDriveFile(fileId).catch(()=>{});
      if(e.name==="AbortError") throw e;
      return {where:"local",downloadId:await saveLocally(url,name),warning:`Drive upload failed (${e.message}). Saved to Downloads instead.`};
    }
  }
  signal?.throwIfAborted();
  return {where:"local",downloadId:await saveLocally(url,name)};
}

// ---------- Sharing ----------
const FILES="https://www.googleapis.com/drive/v3/files";
// Drive error reasons meaning the account/admin forbids "Anyone with the link" sharing.
const POLICY_REASONS=new Set(["publishOutNotPermitted","domainPolicy","sharingRestricted","teamDrivesSharingRestrictionNotAllowed",
  "cannotShareTeamDriveWithNonGoogleAccounts","cannotShareTeamDriveTopFolderWithAnyoneOrDomains","shareOutNotPermitted"]);
const READABLE=new Set(["reader","commenter","writer","fileOrganizer","organizer","owner"]);

export function isSharingPolicyError(e){
  return POLICY_REASONS.has(e?.reason)||/not (allowed|permitted).*(share|sharing|publish)|sharing.*(restrict|policy|disabled)/i.test(e?.detail||"");
}

// Gives "Anyone with the link" view access to an uploaded file (once) and returns its share link.
// Uses the extension's existing Chrome Identity token via driveFetch; works with the drive.file scope
// because the extension created the file.
export async function makeFileShareable(fileId){
  const id=encodeURIComponent(fileId);
  const list=await (await driveFetch(`${FILES}/${id}/permissions?fields=permissions(id,type,role)&supportsAllDrives=true`)).json();
  const hasPublic=(list.permissions||[]).some(p=>p.type==="anyone"&&READABLE.has(p.role));
  if(!hasPublic){
    try{
      await driveFetch(`${FILES}/${id}/permissions?fields=id&supportsAllDrives=true`,{method:"POST",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"anyone",role:"reader"})});
    }catch(e){e.policy=isSharingPolicyError(e);throw e}
  }
  const meta=await (await driveFetch(`${FILES}/${id}?fields=id,name,mimeType,webViewLink,webContentLink,resourceKey&supportsAllDrives=true`)).json();
  if(!meta.webViewLink) throw new Error("Drive did not return a link for this file.");
  // webViewLink already carries ?resourcekey= when the file has one, so it is used as-is.
  return {fileId:meta.id,name:meta.name,webViewLink:meta.webViewLink,resourceKey:meta.resourceKey||null};
}

// Link fields for a history entry; never throws (a failure is recorded so Retry Link can finish it).
export async function getShareLink(fileId){
  try{
    const s=await makeFileShareable(fileId);
    return {shared:true,webViewLink:s.webViewLink,resourceKey:s.resourceKey,shareError:null,sharePolicy:false};
  }catch(e){
    return {shared:false,webViewLink:null,shareError:e.detail||e.message,sharePolicy:!!e.policy};
  }
}

// History patch for a fully uploaded file: "uploaded" with a public link, or "share_failed" keeping the fileId for Retry Link.
export async function shareUploadedFile(fileId){
  const s=await getShareLink(fileId);
  return {status:s.shared?"uploaded":"share_failed",...s};
}
