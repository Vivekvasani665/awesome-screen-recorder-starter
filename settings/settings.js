const msg=t=>document.querySelector("#msg").textContent=t;
const prefix=document.querySelector("#prefix");
chrome.storage.local.get("folderPrefix").then(({folderPrefix})=>{if(folderPrefix) prefix.value=folderPrefix});
document.querySelector("#save").onclick=async()=>{
  const v=prefix.value.trim();
  if(!v){msg("Folder name can't be empty.");return}
  await chrome.storage.local.set({folderPrefix:v});msg("Saved.");
};
document.querySelector("#disconnect").onclick=async()=>{await chrome.identity.clearAllCachedAuthTokens();await chrome.storage.local.set({driveConnected:false});msg("Disconnected. You can reconnect from the extension popup.")};
