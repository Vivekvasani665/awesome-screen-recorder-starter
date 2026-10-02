# Awesome Screen Recorder

Standalone Chrome Manifest V3 extension. No backend/database. It records screen/window/tab media and uploads recordings/screenshots to the user's Google Drive.

## Setup

1. Load this folder at `chrome://extensions` with Developer mode -> Load unpacked.
2. The manifest `key` keeps the extension ID fixed at `gillieeoibggeepoibmolipcnjlhpnfi` on every computer; the OAuth client in `manifest.json` is a Chrome extension client for that ID.
3. Test Connect Google Drive, Record Screen, Screenshot.

So that any Google account can connect (no Test Users), the Google Cloud project must be External and In production — see [GOOGLE_OAUTH_PRODUCTION_SETUP.md](GOOGLE_OAUTH_PRODUCTION_SETUP.md).

The requested Drive scope is `https://www.googleapis.com/auth/drive.file`, which limits access to files the app creates or opens with the app.

## Notes

- Large recordings use Drive resumable upload.
- Recording runs in a small recorder window (minimised automatically) so the popup can close. Keep that window open while recording.
- If Google Drive is not connected (or an upload fails), recordings and screenshots are saved to your Downloads folder instead.
- Settings (gear icon in the popup, or the extension's Options page) control quality, frame rate, bitrate, microphone/system audio, format (WebM, or MP4 where Chrome supports it), auto upload, keeping a local copy, theme and compact mode.
- Share links are generated first: when a recording/screenshot finishes, the extension creates the Drive file, gives it "Anyone with the link can view" access and shows Copy Link / Share / Open right away, then uploads the content into that file. If the upload fails or is cancelled, the empty Drive file is deleted.
- The popup's History view lists the last 50 recordings/screenshots with upload status; entries are stored in `chrome.storage.local`.
- This is a plain Chrome extension: there is no `npm install` / `npm run dev`. Load the folder unpacked and click the reload icon on `chrome://extensions` after editing.
- macOS: allow Chrome in System Settings → Privacy & Security → Screen Recording, then restart Chrome.
- The browser's screen-share picker is always user-controlled.
- Do not add `client_secret` to the extension.
- For production Web Store publishing, complete OAuth verification/privacy-policy requirements as applicable and keep permissions minimal.
