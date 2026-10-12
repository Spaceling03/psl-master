# Security

## Reporting a problem

Please do not open a public issue. Email the administrator at **admin@psetialestari.com**.

## How the website is protected

| Threat | Protection |
|---|---|
| Reading or changing the database without signing in | Firestore and Realtime Database **security rules** on Google's servers refuse every request without a valid Google sign-in. |
| Signing in with a look-alike or unverified account | The rules require a **verified** email; only `@psetialestari.com` accounts, or emails on an **active** employee record, get in. Switching a record off locks that person out everywhere. |
| An employee reading other people's data | The rules give each person **their own** records only; office roles (admin, approvers, HR) see what their job needs. Who's In shows other staff names and in/out only — never leave types or reasons. |
| Someone writing records in another person's name | Every write must carry the signed-in person's own email; the audit trail is **append-only** and sealed (SHA-256), with the database's own clock. |
| Stolen "secret keys" from this repository | There are none. The Firebase web `apiKey` is public by design and opens nothing by itself. Private keys stay on the office PC. |
| Injected scripts (XSS) | Content-Security-Policy: no inline or foreign scripts; all names and text are escaped before they are shown. |
| A changed copy of Google's Firebase files | Subresource Integrity: the browser refuses them unless they match their fingerprint. |
| Clickjacking (the site hidden inside another page) | The page refuses to open inside a frame. |
| Data left on a shared iPad / Mac | Wiped on sign-out and when another account signs in. |
| Secrets pushed by mistake | `.gitignore` keeps key and data files out; the **check** workflow fails any push containing one. |

## One-time settings (administrator)

1. **Firebase console › Authentication › Settings › Authorized domains** — add this site's address
   (e.g. `yourname.github.io`). Without it Google sign-in is refused here.
2. **Firestore rules** — publish the latest `PslShared\psl-master-firestore.rules` from the office PC.
3. **Google Cloud console › APIs & Services › Credentials** (recommended) — create a separate *browser* API key for this site:
   *Application restrictions:* Websites — `https://yourname.github.io/*` and `https://psl-master.firebaseapp.com/*`;
   *API restrictions:* Identity Toolkit API, Token Service API, Cloud Firestore API. Build the site with it
   (`build.ps1 -GitHub -WebKey <the new key>`). Then nobody can use the key from other websites or run up the project's quota.
   (Leave the PC / Android key unrestricted by website — they are not websites.)
4. **GitHub › Settings › Code security** — switch on **Secret scanning** and **Push protection**.
   **Settings › Pages** — source: *Deploy from a branch*, `main`, `/ (root)`; tick **Enforce HTTPS**.
5. Use **two-step verification** on the GitHub account and on the Google admin account.
