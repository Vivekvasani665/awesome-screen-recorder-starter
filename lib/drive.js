// Shared Google Drive + local-save helpers (used by background and recorder page).
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

async function findOrCreateFolder(name,parentId="root"){
  const q=`name='${name.replaceAll("\\","\\\\").replaceAll("'","\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
  const r=await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1&fields=files(id,name)`);
  const data=await r.json(); if(data.files?.[0]) return data.files[0].id;
  const create=await driveFetch("https://www.googleapis.com/drive/v3/files",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,mimeType:"application/vnd.google-apps.folder",parents:[parentId]})});
  return (await create.json()).id;
}

export async function getFolders(){
  const {folderPrefix}=await chrome.storage.local.get("folderPrefix");
  const root=await findOrCreateFolder(folderPrefix||DEFAULT_ROOT);
  const recordings=await findOrCreateFolder(REC,root);
  const screenshots=await findOrCreateFolder(SHOTS,root);
  return {root,recordings,screenshots};
}

async function uploadBlob(blob,name,mimeType,folderId){
  const init=await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",{method:"POST",headers:{
    "Content-Type":"application/json; charset=UTF-8",
    "X-Upload-Content-Type":mimeType,"X-Upload-Content-Length":String(blob.size)
  },body:JSON.stringify({name,mimeType,parents:[folderId]})});
  const session=init.headers.get("Location");
  if(!session) throw new Error("Drive did not return an upload session URL.");
  const put=await fetch(session,{method:"PUT",headers:{"Content-Type":mimeType},body:blob});
  if(!put.ok) throw new Error(`Upload ${put.status}: ${await put.text()}`);
  return put.json();
}

// url: a data: URL or blob: URL
export async function saveLocally(url,name){
  const {folderPrefix}=await chrome.storage.local.get("folderPrefix");
  const dir=(folderPrefix||DEFAULT_ROOT).replace(/[\\/:*?"<>|]/g,"_");
  await chrome.downloads.download({url,filename:`${dir}/${name}`,saveAs:false});
}

// Uploads to Drive when connected; otherwise (or if upload fails) saves to the Downloads folder.
// kind: "recordings" | "screenshots". Returns {where:"drive"|"local", warning?}
export async function saveFile({blob,url,name,mimeType,kind}){
  const {driveConnected}=await chrome.storage.local.get("driveConnected");
  if(driveConnected){
    try{
      const f=await getFolders();
      await uploadBlob(blob,name,mimeType,f[kind]);
      return {where:"drive"};
    }catch(e){
      await saveLocally(url,name);
      return {where:"local",warning:`Drive upload failed (${e.message}). Saved to Downloads instead.`};
    }
  }
  await saveLocally(url,name);
  return {where:"local"};
}
