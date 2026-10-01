// User preferences, stored under the "settings" key in chrome.storage.local.
export const DEFAULTS={
  quality:"1080",      // "720" | "1080" | "1440" | "native"
  fps:30,              // 30 | 60
  bitrate:4500000,     // bits per second
  microphone:false,
  systemAudio:true,
  format:"webm",       // "webm" | "mp4" (mp4 only where MediaRecorder supports it)
  autoUpload:true,     // upload to Drive when connected
  keepLocal:false,     // also save a copy to Downloads when uploading
  theme:"system",      // "system" | "light" | "dark"
  compact:false,
};

export async function getSettings(){
  const {settings}=await chrome.storage.local.get("settings");
  return {...DEFAULTS,...settings};
}

export async function saveSettings(patch){
  const next={...await getSettings(),...patch};
  await chrome.storage.local.set({settings:next});
  return next;
}
