// Shared Google Drive + local-save helpers (used by background and recorder page).
import {getSettings} from "./settings.js";

const DEFAULT_ROOT="Awesome Screen Recorder";
const REC="Recordings";
const SHOTS="Screenshots";

export function clientIdConfigured(){
  const id=chrome.runtime.getManifest().oauth2?.client_id||"";
  return !!id && !id.startsWith("YOUR_") && id.endsWith(".apps.googleusercontent.com");
}

// ---------- Errors people can act on ----------
// Chrome reports OAuth failures as plain strings; each is mapped to a message that says what to do.
// Raw messages are never shown, and tokens are never logged.
export class DriveError extends Error{
  constructor(message,code,extra={}){super(message);this.name="DriveError";this.code=code;Object.assign(this,extra)}
}

const AUTH_MESSAGES=[
  [/did not approve|access_denied|user denied|canceled|cancelled|closed by the user/i,"denied",
    "Google account access was denied. Please allow Google Drive access and try again. If Google showed “Access blocked”, this app is still in Testing mode: the app owner must publish it to Production or add your account as a Test User."],
  [/has not completed the google verification|testing mode|test user|not a test user|org_internal|developer.*not.*approved/i,"testing",
    "This Google Cloud app is still in Testing mode. The app owner must publish it to Production or add this account as a Test User."],
  [/admin_policy_enforced|administrator|admin.*(block|restrict)|disallowed_useragent|access blocked.*(organization|domain)/i,"admin",
    "Your Google Workspace administrator may be blocking this app. Try another Google account or contact your administrator."],
  [/invalid_client|bad client id|invalid oauth2 client id|oauth2 client id|unauthorized_client|redirect_uri_mismatch/i,"client",
    "Google rejected this extension's OAuth client. The app owner must check that the OAuth client in Google Cloud is a “Chrome extension” client for extension ID "+chrome.runtime.id+"."],
  [/invalid_grant|not granted or revoked|token.*(expired|revoked)/i,"stale",
    "Your Google sign-in has expired or was revoked. Please connect Google Drive again."],
  [/not supported|function unsupported|unsupported on/i,"browser",
    "Google sign-in for extensions only works in Google Chrome. Open this extension in Chrome and try again."],
  [/turned off browser signin|sign-?in is disabled|signin.*disabled/i,"signin",
    "Chrome sign-in is turned off. Turn on “Allow Chrome sign-in” in Chrome settings → You and Google → Sync, then try again."],
  [/could not be loaded|network|failed to fetch|offline/i,"network",
    "Couldn't reach Google. Check your internet connection and try again."],
];

export function explainAuthError(e){
  if(e instanceof DriveError) return e;
  const raw=String(e?.message||e||"");
  for(const [re,code,message] of AUTH_MESSAGES) if(re.test(raw)) return new DriveError(message,code);
  return new DriveError("Google sign-in didn't complete. Please try Connect Google Drive again.","auth");
}

// Drive API failures in plain words; the share-policy fields (reason/detail) are kept for isSharingPolicyError.
function explainDriveError(status,reason,detail){
  const msg=
    status===401?"Your Google sign-in has expired. Please connect Google Drive again.":
    reason==="accessNotConfigured"||/has not been used|is disabled/i.test(detail)?"The Google Drive API is not enabled for this app's Google Cloud project. The app owner must enable it.":
    reason==="insufficientPermissions"||reason==="insufficientFilePermissions"?"This app doesn't have permission to use that Drive file. Please connect Google Drive again and allow access.":
    reason==="storageQuotaExceeded"||reason==="quotaExceeded"?"Your Google Drive is full. Free up space and try again.":
    reason==="domainPolicy"||/administrator|admin policy/i.test(detail)?"Your Google Workspace administrator is blocking this action. Contact your administrator.":
    reason==="rateLimitExceeded"||reason==="userRateLimitExceeded"||status===429?"Google Drive is busy. Please wait a moment and try again.":
    status===404?"The file or folder was not found in Google Drive. It may have been deleted.":
    status>=500?"Google Drive is temporarily unavailable. Please try again shortly.":
    `Google Drive refused the request (${status}). Please try again.`;
  return new DriveError(msg,status===401?"stale":"drive",{status,reason,detail});
}

const errorText=e=>String(e?.message||e||"");

/**
 * A cached token, silently (never opens a window). Uploads, sharing and folder lookups run
 * in the background, so they must never pop up a Google sign-in on their own; if access has
 * lapsed, the user is asked to reconnect from the popup instead.
 */
export async function getToken(){
  if(!clientIdConfigured()) throw new DriveError("Google Drive is not set up: the OAuth client ID in manifest.json is missing.","config");
  let r;
  try{r=await chrome.identity.getAuthToken({interactive:false})}
  catch(e){const x=explainAuthError(e);throw x.code==="denied"||x.code==="auth"?new DriveError("Google Drive needs to be reconnected. Open the extension and click Connect Google Drive.","reconnect"):x}
  if(!r?.token) throw new DriveError("Google Drive needs to be reconnected. Open the extension and click Connect Google Drive.","reconnect");
  return r.token;
}

/**
 * The interactive sign-in, run only from an explicit "Connect Google Drive" click.
 * A stale cached credential (expired / revoked) gets one clean retry after clearing
 * Chrome's token cache; anything else fails straight away with an actionable message.
 */
export async function connectInteractive(){
  if(!clientIdConfigured()) throw new DriveError("Google Drive is not set up: the OAuth client ID in manifest.json is missing.","config");
  const attempt=async()=>{
    const r=await chrome.identity.getAuthToken({interactive:true});
    if(!r?.token) throw new Error("access_denied");
    return r.token;
  };
  try{return await attempt()}
  catch(e){
    const first=explainAuthError(e);
    if(first.code!=="stale") throw first;
    await chrome.identity.clearAllCachedAuthTokens();
    try{return await attempt()}catch(e2){throw explainAuthError(e2)}
  }
}

/** Forgets this extension's Google access: revokes the token at Google (best effort) and clears Chrome's cache. */
export async function disconnect(){
  try{
    const r=await chrome.identity.getAuthToken({interactive:false});
    if(r?.token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(r.token)}`,{method:"POST"}).catch(()=>{});
  }catch{}
  await chrome.identity.clearAllCachedAuthTokens();
}

async function driveFetch(url,options={}){
  let token=await getToken();
  let res;
  const go=t=>fetch(url,{...options,headers:{Authorization:`Bearer ${t}`,...(options.headers||{})}});
  try{res=await go(token)}catch(e){if(e.name==="AbortError") throw e;throw new DriveError("Couldn't reach Google Drive. Check your internet connection and try again.","network")}
  // Expired token: drop it from Chrome's cache and retry once with a fresh one (still silent).
  if(res.status===401){await chrome.identity.removeCachedAuthToken({token});token=await getToken();res=await go(token)}
  if(!res.ok){
    const text=await res.text();
    let reason="",detail="";
    try{const j=JSON.parse(text).error;reason=j?.errors?.[0]?.reason||j?.status||"";detail=j?.message||""}catch{}
    throw explainDriveError(res.status,reason,detail);
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
      if(!put.ok){await put.text().catch(()=>"");throw explainDriveError(put.status,"","")}
      return put.json();
    });
  }
  return new Promise((resolve,reject)=>{
    const x=new XMLHttpRequest();
    x.open("PUT",session);
    x.setRequestHeader("Content-Type",mimeType);
    x.responseType="json";
    x.upload.onprogress=e=>{if(e.lengthComputable) onProgress(e.loaded/e.total)};
    x.onload=()=>x.status>=200&&x.status<300?resolve(x.response||{}):reject(explainDriveError(x.status,"",""));
    x.onerror=()=>reject(new DriveError("The upload was interrupted. Check your internet connection and try again.","network"));
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
      // Access lapsed or was revoked: show Drive as disconnected so the popup offers Connect again.
      if(e.code==="reconnect"||e.code==="stale") await chrome.storage.local.set({driveConnected:false});
      return {where:"local",downloadId:await saveLocally(url,name),warning:`${e.message} Saved to Downloads instead.`};
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
    }catch(e){
      e.policy=isSharingPolicyError(e);
      if(e.policy) e.message="Your Google Workspace settings don't allow “Anyone with the link” sharing. The file is uploaded, but a public link can't be created.";
      throw e;
    }
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
    return {shared:false,webViewLink:null,shareError:`File uploaded, but a shareable link could not be created. ${e.message}`,sharePolicy:!!e.policy};
  }
}

// History patch for a fully uploaded file: "uploaded" with a public link, or "share_failed" keeping the fileId for Retry Link.
export async function shareUploadedFile(fileId){
  const s=await getShareLink(fileId);
  return {status:s.shared?"uploaded":"share_failed",...s};
}
