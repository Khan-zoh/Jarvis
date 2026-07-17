# Connecting Google (Gmail, Calendar, Drive)

Jarvis talks to your Google account with an **installed-app OAuth 2.0** flow: you create your own
Google Cloud OAuth client, paste its ID/secret into Settings, and click **Connect**. Jarvis opens a
browser to Google's consent screen, catches the redirect on a temporary `http://127.0.0.1:<port>`
server, and stores the resulting tokens **encrypted** on your machine (Windows DPAPI, your user
account only). Nothing is sent to any third party — the tokens go straight from Google to your PC.

This is a one-time, ~10-minute setup because Google requires each user to bring their own OAuth
client for a desktop app.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Top bar → project dropdown → **New Project**. Name it (e.g. `Jarvis`) and **Create**.
3. Make sure the new project is selected in the top bar before continuing.

## 2. Enable the three APIs

Under **APIs & Services → Library**, search for and **Enable** each of:

- **Gmail API**
- **Google Calendar API**
- **Google Drive API**

(Enabling an API just makes it callable; it grants no access on its own — the scopes below do that.)

## 3. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen**:

1. **User type: External**, then **Create**. (Internal is only for Google Workspace orgs.)
2. Fill the required fields: app name (`Jarvis`), your email as user support email, and your email
   as the developer contact. Everything else can stay blank. **Save and continue**.
3. **Scopes**: you can skip adding scopes here — Jarvis requests them at connect time. **Save and
   continue**.
4. **Test users**: click **Add users** and add **your own Google account**. In *Testing* mode only
   listed test users may connect. **Save and continue**.
5. Leave the app in **Testing** (do not publish) unless you hit the 7-day expiry below.

### Scopes Jarvis requests (and why)

Jarvis asks for the **narrowest scope per capability** — never broad `gmail.modify` or full
`calendar` access:

| Scope | Consent screen wording | Why Jarvis needs it |
|---|---|---|
| `gmail.readonly` | View your email messages and settings | search & read mail (never modify or delete) |
| `gmail.send` | Send email on your behalf | send mail you dictate — no read access implied by this scope |
| `calendar.events` | View and edit events on your calendars | list, create, and delete events (NOT calendar sharing/ACLs) |
| `drive.readonly` | See and download your Google Drive files | search & read Drive files (no write or delete) |
| `userinfo.email` | See your primary email address | show which account is connected in Settings |

Google will show a "Google hasn't verified this app" warning during consent because the app is in
Testing mode and unverified — this is expected for your own desktop client. Click **Advanced →
Go to Jarvis (unsafe)** to proceed. It is *your* client and *your* data.

## 4. Create the OAuth client (Desktop app)

**APIs & Services → Credentials → Create Credentials → OAuth client ID**:

1. **Application type: Desktop app**.
2. Name it (e.g. `Jarvis Desktop`) and **Create**.
3. Copy the **Client ID** and **Client secret** from the dialog (you can re-open them any time from
   the Credentials list).

> No redirect URI needs to be entered: for Desktop clients Google automatically allows the
> `http://127.0.0.1` loopback on any port, which is exactly what Jarvis uses.

## 5. Paste into Jarvis and connect

1. Open Jarvis **Settings → Google**.
2. Paste the **Client ID** and **Client secret** (the secret is stored encrypted; it never lands in
   `config.json` in plaintext).
3. Click **Connect**. Your browser opens Google's consent screen; approve the scopes above.
4. The browser shows "Jarvis is connected" — return to Jarvis. Settings now shows your connected
   email. Done.

To sign out later, click **Disconnect**: Jarvis revokes the tokens with Google and deletes the
local token file.

## The 7-day expiry in Testing mode

While the OAuth consent screen is in **Testing** (unpublished), Google **expires the refresh token
after 7 days**. When that happens Jarvis' Google tools stop working and you'll need to click
**Connect** again to re-consent.

Two ways to avoid the weekly re-consent:

- **Just re-connect** when it lapses (simplest for personal use).
- **Publish the app**: OAuth consent screen → **Publishing status → Publish app**. For an unverified
  app used only by yourself this removes the 7-day expiry. (Google's verification is only required
  if you distribute the client to other users, which you are not.)

## Where the tokens live

- File: `%APPDATA%\Jarvis\google\token.json` (under Jarvis' `userData` dir).
- Contents: a Windows-DPAPI (CurrentUser) encrypted blob. The refresh token is **never** written in
  plaintext. Only your Windows user account can decrypt it.
- The disposable tools-mcp worker only ever *reads* this file; the OAuth flow itself only runs from
  the Jarvis app when you click Connect.
