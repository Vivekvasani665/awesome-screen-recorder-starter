# Google OAuth — production setup

Goal: anyone can **Load unpacked → Connect Google Drive → choose any Google
account → Allow → Drive connected**, without being added as a Test User.

That is decided by the **Google Cloud project**, not by extension code. The
extension already does its part (see "What the extension does" below); the
steps here must be done by the app owner in Google Cloud Console.

## Current configuration (from `manifest.json`)

| Item | Value |
| --- | --- |
| OAuth client ID | `599992124415-jb2b54r64q5dki2ovd4jh2aj1jul2tin.apps.googleusercontent.com` |
| Scope | `https://www.googleapis.com/auth/drive.file` (only files this app creates) |
| Manifest `key` | present — gives a stable extension ID |
| Extension ID | `gillieeoibggeepoibmolipcnjlhpnfi` |
| Client secret | none (a Chrome extension must never contain one) |

## Google Cloud steps

1. Open <https://console.cloud.google.com/>.
2. Select the **Awesome Screen Recorder** project (the one that owns the client ID above).
3. Open **Google Auth Platform** (formerly "OAuth consent screen").
4. **Branding** — app name, user support email, app logo (optional), developer
   contact email. For production also add: application home page, privacy
   policy URL, and terms of service URL. Authorised domains must cover those URLs.
5. **Audience** — open it.
6. **User type = External.** ("Internal" only allows accounts in your own Workspace.)
7. **Publishing status** — click **Publish app** so it shows **In production**.
   While it says *Testing*, only listed Test Users can sign in (max 100) and
   their tokens expire after 7 days.
8. **Data Access** — the scope list.
9. Keep exactly one scope: `.../auth/drive.file`. Remove `.../auth/drive` or
   other Drive scopes if present; they make verification much harder.
10. **Clients** — open the client list.
11. The client used in `manifest.json` must be of type **Chrome extension**, and
    its **Item ID** must be `gillieeoibggeepoibmolipcnjlhpnfi`. If the type is
    "Web application", or the Item ID differs, sign-in fails with
    `bad client id` / `invalid_client` on every machine whose extension ID doesn't match.
12. **Verification Center** — check whether Google asks for verification.
13. If it does, complete it (brand verification: verified domain, privacy policy,
    home page). `drive.file` is a *non-sensitive* scope, so normally no security
    assessment is required — but Google decides; follow what the Verification
    Center shows. Until verification passes, users may see
    "Google hasn't verified this app" or "Access blocked".
14. **APIs & Services → Library → Google Drive API → Enable** (if not already).
15. Test with a Gmail account that is **not** a Test User and not an owner of
    the project, on a different computer (see below).

> Only after steps 6–7 (and 13, if Google requires it) can any Gmail account
> connect. Code changes alone cannot make that happen.

## Multi-device: same extension ID everywhere

The manifest `key` fixes the extension ID, so the OAuth client's Item ID matches
on every computer that loads the same folder.

- Copy the extension folder as-is (keep `"key"` in `manifest.json`).
- **Never** copy or commit the private key (`*.pem`). It is not needed to load
  unpacked; `.gitignore` excludes it.

Verify the ID:

- `chrome://extensions` → Developer mode on → the card shows
  **ID: gillieeoibggeepoibmolipcnjlhpnfi**.
- Or: open the popup, right-click → Inspect → Console:

  ```js
  chrome.runtime.id
  ```

If the ID differs, the `key` was removed or changed — restore it.

## Clearing a stuck sign-in

In the extension's console (popup → Inspect, or the service worker from
`chrome://extensions`):

```js
await chrome.identity.clearAllCachedAuthTokens();
```

The extension's **Disconnect** button does this too (and revokes the token at
Google). Then click **Connect Google Drive** again.

## What the extension does

- Google sign-in opens **only** when the user clicks **Connect Google Drive**
  (`chrome.identity.getAuthToken({ interactive: true })`). Uploads, sharing and
  folder lookups use the cached token silently and never open a sign-in window;
  if access has lapsed, Drive is shown as disconnected and the user reconnects.
- An expired/revoked cached token is cleared and the sign-in retried **once**.
- OAuth and Drive errors are shown as specific, actionable messages
  (denied, Testing mode, Workspace admin block, wrong client, Drive API
  disabled, Drive full, network). Tokens are never logged.
- Uploads go to `Awesome Screen Recorder/Recordings` and
  `Awesome Screen Recorder/Screenshots`, then get an "Anyone with the link"
  reader permission. If that fails (e.g. Workspace policy), the file stays
  uploaded and **Retry Link** only retries the permission — never the upload.

## Known limits

- `chrome.identity.getAuthToken` works in **Google Chrome** only (not Edge,
  Brave, Opera…).
- Chrome uses the account(s) signed in to the Chrome profile. To connect a
  different Google account, add it to the profile (or pick it in Google's
  account chooser), or use another Chrome profile.
- Workspace admins can block third-party apps or "Anyone with the link"
  sharing; the extension reports this but cannot override it.

## Test checklist

1. `chrome://extensions` → Developer mode → **Load unpacked** → select this folder.
2. Confirm the ID is `gillieeoibggeepoibmolipcnjlhpnfi`.
3. Popup → **Connect Google Drive** → choose an account → **Allow** →
   "✓ Google Drive connected successfully".
4. Take a screenshot → it uploads and shows Copy Link / Open.
5. Record a few seconds → Pause → Resume → Stop → it uploads with a link.
6. **Disconnect** → files save to Downloads; **Connect** again works.
7. Repeat steps 1–3 on a second computer with a different Gmail account.
