# psl-master
Website for PSL operational efficiency

Thanks for reading my README, have the greatest day of your life!

Regards,
Andy Ajeng
(Super Senior Head of IT, Website Magician, Software Prophet, AI Whisperer)
PSL

---

## PSL Master (web)

The staff app of **Pembinaan Setia Lestari Sdn Bhd** for iPhone, iPad and Mac — overtime credits, leave, the company calendar,
Who's In, approvals, licences and tenders. **Staff only:** you sign in with your Google account, and only company accounts
(and people the administrator has put on an active employee record) get in.

| Device | Layout |
|---|---|
| iPhone | The phone app (tabs at the bottom). Add it to the Home Screen (Share › Add to Home Screen) for reminders. |
| iPad (landscape), Mac | The PC app's layout: the menu on the left, the page on the right. |
| iPad (portrait) | The phone layout, centred. |

This repository holds only the **built website** (plain HTML, CSS and JavaScript). It is made from the PSL Master sources on the
office PC (`PSLMasterWeb\build.ps1 -GitHub`) — do not edit the files here by hand.

### Why a public repository is safe

Nothing in this repository is secret, and nothing in it grants access to anything:

* **The Firebase settings** (`apiKey`, project ID) are public by design — they only say *which* project to talk to. Google
  documents this: the key is not a password.
* **Every read and write is checked by the database's own rules** on Google's servers, using the person's Google sign-in:
  a verified email, a company account or an active employee record, and only what that person may see (their own records;
  the office roles see more). Knowing the address of the database gets nobody anything.
* **No server, no passwords, no private keys.** The reminder service's private key, the admin's signature pictures and every
  signed form stay on the office PC.
* **The pages only load Google's sign-in and Firebase** (a Content-Security-Policy), check Google's files against their
  fingerprints (Subresource Integrity), refuse to open inside another website, and are kept out of search engines.
* **On shared iPads and Macs**, a person's data is wiped from the device when they sign out, or when someone else signs in.
* **Every push is checked** (`.github/workflows/check.yml`): a private key, a service-account file, an OAuth secret or token,
  or an unknown API key in the files fails the check.

See [SECURITY.md](SECURITY.md) for the details and the one-time settings.
