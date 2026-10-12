"use strict";
/* PSL Master on the iPhone (and in any browser). The screens are the Android app's own (app.js, engine.js, app.css - copied
   from PSLMasterAndroid when building); this file plays the part of the Android bridge, window.Native:
   - Google sign-in (Firebase Auth, redirect) + the same allow-list check as the PC and Android apps;
   - database requests (Firestore REST with the person's token) and the live-update doorbell (Realtime Database stream);
   - reminders: the iPhone cannot wake up at 9:00 by itself, so it subscribes to Web Push and the admin PC (PSL Master)
     sends ONE summary at the person's chosen times (push_subs/{email} keeps the subscription and the choices).
   Opened with ?demo it runs on the pretend database instead (for looking at the screens).
   On an iPad in landscape or a Mac, desktop.js adds the PC app's menu on the left.
   SECURITY (this site is published from a PUBLIC GitHub repository): nothing here is secret. The Firebase "apiKey" only names the
   project - it opens nothing by itself. Every read and write is checked by the database rules (PslShared\psl-master-firestore.rules)
   against the person's Google sign-in (verified email, an active employee record), exactly as for the PC and Android apps. What this
   device keeps (the person's own data, for offline starts) is wiped when they sign out or another account signs in. */
(function () {
  const BUILD = "2026.10.12.1518";
  const PROJECT = "psl-master", API_KEY = "AIzaSyBdIiebcZSgDBRy0Stm-aQh8rzjs9mP73M", ADMIN = "admin@psetialestari.com";
  const FSB = "https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents";
  const RTDB = "https://psl-master-default-rtdb.asia-southeast1.firebasedatabase.app";
  const HOME = "https://psl-master.firebaseapp.com";
  const qs = new URLSearchParams(location.search);

  // one address for everybody: sign-in works best when the app and its sign-in page share one site (Safari)
  if (location.hostname === "psl-master.web.app") { location.replace(HOME + location.pathname + location.search); return; }

  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });

  // "Add to Home Screen" hint for iPhone users still in a Safari tab
  function installHint() {
    const h = document.getElementById("installHint");
    if (!h || !isIOS() || standalone() || localStorage.getItem("psl.web.hintClosed")) return;
    h.classList.remove("hidden");
    h.querySelector("button").onclick = () => { h.classList.add("hidden"); try { localStorage.setItem("psl.web.hintClosed", "1"); } catch (e) { } };
  }
  document.addEventListener("DOMContentLoaded", installHint);

  // the screens (app.js), then the iPad / Mac menu (desktop.js)
  function loadApp(after) {
    const s = document.createElement("script");
    s.src = "app.js?v=" + BUILD;
    s.onload = () => {
      const d = document.createElement("script");
      d.src = "desktop.js?v=" + BUILD;
      d.onload = d.onerror = () => { if (after) after(); };
      document.body.appendChild(d);
    };
    document.body.appendChild(s);
  }

  if (qs.has("demo")) { document.addEventListener("DOMContentLoaded", () => loadApp()); return; }

  // ------------------------------------------------------------------ small helpers
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  // what this device keeps of a person's data (for starting offline): gone at sign-out, and before another account uses it
  function clearKept() {
    try { Object.keys(localStorage).filter(k => k.indexOf("psl.web.cache.") === 0).forEach(k => localStorage.removeItem(k)); } catch (e) { /* private mode */ }
    store.set("psl.web.owner", null);
  }
  const escHtml = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function tell(title, msg) {
    if (typeof window.sheet === "function") window.sheet(title, escHtml(msg).replace(/\n/g, "<br>"), [{ label: "OK", cls: "p" }]);
    else alert(title + "\n\n" + msg);
  }
  const b64u = bytes => btoa(String.fromCharCode.apply(null, new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function fromB64u(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    const b = atob(s), out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }

  // SHA-256 (the record's code - same as the PC and Android apps; it must answer at once, so not crypto.subtle)
  function sha256hex(text) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const bytes = new TextEncoder().encode(text);
    const len = bytes.length, total = ((len + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(total); m.set(bytes); m[len] = 0x80;
    const bits = len * 8;
    for (let i = 0; i < 4; i++) m[total - 1 - i] = (bits >>> (8 * i)) & 0xff;
    m[total - 5] = Math.floor(bits / 0x100000000) & 0xff;
    let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    const r = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + hh].map(x => x | 0);
    }
    return h.map(x => ("00000000" + (x >>> 0).toString(16)).slice(-8)).join("");
  }
  window.__sha256 = sha256hex;      // for checking

  // ------------------------------------------------------------------ sign-in (Google, through Firebase Auth)
  firebase.initializeApp({ apiKey: API_KEY, projectId: PROJECT,
    authDomain: /\.firebaseapp\.com$/.test(location.hostname) ? location.hostname : "psl-master.firebaseapp.com" });
  const auth = firebase.auth();
  const getSession = () => { try { return JSON.parse(store.get("psl.web.session") || "null"); } catch (e) { return null; } };
  const setSession = s => store.set("psl.web.session", s ? JSON.stringify(s) : null);
  let booted = false, appReady = false, redirectError = "";
  const toApp = s => { if (appReady && window.__auth) window.__auth(JSON.stringify(s)); };

  function friendly(e) {
    const c = (e && e.code) || "";
    if (/network-request-failed/.test(c)) return "No internet connection - try again when you are online.";
    if (/popup-closed|cancelled|user-cancelled/.test(c)) return "Sign-in was cancelled.";
    if (/unauthorized-domain/.test(c)) return "This address (" + location.hostname + ") is not allowed to sign in yet - the admin adds it in Firebase (Authentication > Settings > Authorized domains), or open " + HOME;
    if (/popup-blocked/.test(c)) return "The sign-in window was blocked - allow pop-ups for this site and try again.";
    return "Sign-in failed: " + ((e && e.message) || c || e);
  }

  // the allow-list, as on the PC and Android: the admin, or an ACTIVE employee record with this email (employee_logins)
  async function admit(user) {
    const email = String(user.email || "").trim().toLowerCase();
    const admin = email === ADMIN;
    try {
      const tok = await user.getIdToken();
      const r = await fetch(FSB + "/employee_logins/" + encodeURIComponent(email), { headers: { Authorization: "Bearer " + tok } });
      let employeeId = "", active = false;
      if (r.status === 200) {
        const f = (await r.json()).fields || {};
        active = !!(f.active && f.active.booleanValue);
        employeeId = (f.employeeId && f.employeeId.stringValue || "").trim().toUpperCase();
        if (!active && !admin) throw new Error("Your employee ID " + employeeId + " has been switched off. Please contact the administrator.");
      } else if (!admin && !(r.status === 404 && /^[a-z0-9._%+-]+@psetialestari[.]com$/.test(email)))      // company accounts need no employee ID
        throw new Error(email + " is not the email of a working employee ID. Sign in with your company account (@psetialestari.com), or ask the administrator to put this email on your employee record (People in PSL Master).");
      const s = { signedIn: true, email, name: user.displayName || "", employeeId, isAdmin: admin };
      if (store.get("psl.web.owner") && store.get("psl.web.owner") !== email) clearKept();      // somebody else used this device before
      store.set("psl.web.owner", email);
      setSession(s);
      return s;
    } catch (e) {
      try { await auth.signOut(); } catch (x) { /* fine */ }
      setSession(null);
      return { signedIn: false, error: e && e.message ? (/Failed to fetch|NetworkError|Load failed/.test(e.message) ? "No internet connection - could not check your employee record." : e.message) : String(e) };
    }
  }

  function boot() {
    if (booted) return;
    booted = true;
    loadApp(() => {
      appReady = true;
      if (redirectError && !(getSession() || {}).signedIn) toApp({ signedIn: false, error: redirectError });
      const g = qs.get("goto");
      if (g) { history.replaceState(null, "", location.pathname); setTimeout(() => window.goTo && window.goTo(g), 400); }
    });
  }

  auth.getRedirectResult().catch(e => { redirectError = friendly(e); toApp({ signedIn: false, error: redirectError }); });
  let first = true;
  auth.onAuthStateChanged(async user => {
    if (!user) {
      if (getSession()) clearKept();                 // signed out (here, or the sign-in ran out): nothing of theirs stays on the device
      setSession(null);
      if (first) { first = false; boot(); } else toApp({ signedIn: false });
      return;
    }
    const known = getSession();
    if (known && known.signedIn && known.email === String(user.email || "").toLowerCase()) { if (first) { first = false; boot(); } return; }
    const s = await admit(user);
    if (first) { first = false; boot(); } else toApp(s);
  });
  document.addEventListener("DOMContentLoaded", () => setTimeout(() => { if (!booted && !navigator.onLine) boot(); }, 4000));   // offline: show what this phone has

  // ------------------------------------------------------------------ database requests
  const answer = (id, status, body) => { if (window.__net) window.__net(id, status, body); };
  async function doRequest(id, method, url, headersJson, body, needAuth) {
    try {
      let headers = {}; try { headers = JSON.parse(headersJson || "{}"); } catch (e) { headers = {}; }
      const send = (tok) => {
        let u = url; const h = Object.assign({}, headers);
        if (tok) { if (url.indexOf(RTDB) === 0) u += (u.indexOf("?") >= 0 ? "&" : "?") + "auth=" + encodeURIComponent(tok); else h.Authorization = "Bearer " + tok; }
        return fetch(u, { method, headers: h, body: body == null ? undefined : body });
      };
      if (!needAuth) { const r0 = await send(null); return answer(id, r0.status, await r0.text()); }
      const user = auth.currentUser;
      if (!user) return answer(id, 401, '{"error":{"message":"SIGNED_OUT"}}');
      let r = await send(await user.getIdToken());
      if (r.status === 401) r = await send(await user.getIdToken(true));
      answer(id, r.status, await r.text());
    } catch (e) { answer(id, 0, '{"error":{"message":"OFFLINE"}}'); }
  }

  async function fsDoc(method, path, body) {
    const user = auth.currentUser; if (!user) throw new Error("Please sign in again.");
    const r = await fetch(FSB + "/" + path, { method, headers: { Authorization: "Bearer " + await user.getIdToken(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 404 && method === "GET") return null;
    if (!r.ok) throw new Error("The database said " + r.status + (r.status === 403 ? " (the latest database rules are not published yet - tell the admin)" : ""));
    return method === "DELETE" ? null : r.json();
  }

  // ------------------------------------------------------------------ live updates (the same doorbell as the PC and Android apps)
  let es = null, liveWanted = false, primed = false, retry = 3, retryTimer = null;
  const last = {};
  const liveState = on => { if (window.__live) window.__live(on); };
  function flatten(path, v, into) {
    if (v && typeof v === "object") { Object.keys(v).forEach(k => flatten(path ? path + "/" + k : k, v[k], into)); return; }
    if (path) into[path] = v == null ? null : String(v);
  }
  function feed(ev, data) {
    const out = [];
    let o; try { o = JSON.parse(data); } catch (e) { return out; }
    if (!o) return out;
    const path = String(o.path || "/").replace(/^\/+|\/+$/g, "");
    const now = {};
    if (ev === "put") { Object.keys(last).forEach(k => { if (path === "" || k === path || k.indexOf(path + "/") === 0) now[k] = null; }); flatten(path, o.data, now); }
    else if (o.data && typeof o.data === "object") Object.keys(o.data).forEach(k => flatten(path ? path + "/" + k : k, o.data[k], now));
    const was = primed; primed = true;
    Object.keys(now).forEach(k => {
      const v = now[k], had = Object.prototype.hasOwnProperty.call(last, k);
      if (v === null) { if (had) { delete last[k]; if (was) out.push(k); } return; }
      if (!had || last[k] !== v) { last[k] = v; if (was) out.push(k); }
    });
    return out;
  }
  window.__liveFeed = feed;           // for checking
  function closeEs() { if (es) { try { es.close(); } catch (e) { /* fine */ } es = null; } }
  function later(sec) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (liveWanted) liveStart(); }, sec * 1000); }
  async function liveStart() {
    liveWanted = true;
    if (es || !auth.currentUser || typeof EventSource === "undefined") return;
    let tok; try { tok = await auth.currentUser.getIdToken(); } catch (e) { liveState(false); later(retry); return; }
    if (!liveWanted || es) return;
    es = new EventSource(RTDB + "/signals.json?auth=" + encodeURIComponent(tok));
    const onData = name => e => { liveState(true); retry = 3; const keys = feed(name, e.data); if (keys.length && window.__signal) window.__signal(keys); };
    es.addEventListener("put", onData("put"));
    es.addEventListener("patch", onData("patch"));
    es.addEventListener("keep-alive", () => liveState(true));
    es.addEventListener("cancel", () => { closeEs(); liveState(false); later(60); });
    es.addEventListener("auth_revoked", () => { closeEs(); auth.currentUser && auth.currentUser.getIdToken(true).catch(() => { }).then(() => later(1)); });
    es.onerror = () => { closeEs(); liveState(false); later(retry); retry = Math.min(retry * 2, 120); };
  }
  function liveStop() { liveWanted = false; clearTimeout(retryTimer); closeEs(); liveState(false); }

  // on screen again: catch up (like the Android app's onResume); in the background: no live stream
  document.addEventListener("visibilitychange", () => {
    if (!appReady) return;
    if (document.hidden) liveStop(); else if (window.onPhoneResume) window.onPhoneResume("");
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.goto && window.goTo) window.goTo(e.data.goto); });

  // ------------------------------------------------------------------ reminders (Web Push from the admin PC)
  const REM_DEFAULT = { on: true, times: ["09:00", "17:00"], confirm: true, mine: true, licences: true, tenders: true, sound: "important" };
  function remSettings() { let r = {}; try { r = JSON.parse(store.get("psl.web.rem") || "{}"); } catch (e) { r = {}; } return Object.assign({}, REM_DEFAULT, r); }
  const pushOn = () => typeof Notification !== "undefined" && Notification.permission === "granted" && store.get("psl.web.pushOk") === "1";
  const me = () => (getSession() || {}).email || "";

  async function saveSub(extra) {
    const email = me(); if (!email) return;
    const fields = Object.assign({ email, settings: JSON.stringify(remSettings()), updatedAt: new Date().toISOString().slice(0, 19), app: "web " + BUILD }, extra || {});
    const mask = Object.keys(fields).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
    const doc = { fields: {} };
    Object.keys(fields).forEach(k => doc.fields[k] = { stringValue: String(fields[k]) });
    await fsDoc("PATCH", "push_subs/" + encodeURIComponent(email) + "?" + mask, doc);
  }

  async function enablePush() {
    if (isIOS() && !standalone()) { tell("Add PSL Master to your Home Screen first", "In Safari tap the Share button, then \"Add to Home Screen\". Open PSL Master from the Home Screen and allow notifications there - iPhones only send reminders to apps on the Home Screen."); return; }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") { tell("Reminders", "This browser cannot show reminders. On iPhone you need iOS 16.4 or newer, with PSL Master added to the Home Screen."); return; }
    // the iPhone only asks when the person tapped something (the app also tries once at the start - that one is skipped)
    if (Notification.permission === "default" && navigator.userActivation && !navigator.userActivation.isActive) return;
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") { tell("Notifications are off", "Turn them on in the iPhone's Settings > Notifications > PSL Master, then come back and tap Allow notifications."); if (window.onPermission) window.onPermission(); return; }
    try {
      const cfg = await fsDoc("GET", "push_config/vapid");
      const key = cfg && cfg.fields && cfg.fields.publicKey && cfg.fields.publicKey.stringValue;
      if (!key) { tell("Reminders are not ready yet", "The admin PC (PSL Master, signed in as admin) has to run once to switch reminders on for everybody. Try again later."); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub && sub.options && sub.options.applicationServerKey && b64u(sub.options.applicationServerKey) !== key) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
      const j = sub.toJSON();
      await saveSub({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
      store.set("psl.web.pushOk", "1");
      if (window.toast) window.toast("Reminders are on");
    } catch (e) { tell("Could not turn reminders on", e.message || String(e)); }
    if (window.onPermission) window.onPermission();
  }

  async function dropPush() {
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) { /* fine */ }
    try { if (me()) await fsDoc("DELETE", "push_subs/" + encodeURIComponent(me())); } catch (e) { /* the admin PC removes it when the push fails */ }
    store.set("psl.web.pushOk", null);
  }

  // ------------------------------------------------------------------ what app.js calls (the same as the Android bridge)
  window.Native = {
    session: () => JSON.stringify(getSession() || { signedIn: false }),
    signIn() {
      const p = new firebase.auth.GoogleAuthProvider();
      p.setCustomParameters({ prompt: "select_account" });
      const redirect = () => auth.signInWithRedirect(p).catch(e => toApp({ signedIn: false, error: friendly(e) }));
      // On the Firebase address the sign-in page is the same site: the redirect works everywhere. On any other address (GitHub
      // Pages) Safari blocks the redirect's cross-site storage, so Google's sign-in opens in a small window instead.
      if (/\.firebaseapp\.com$/.test(location.hostname)) { redirect(); return; }
      auth.signInWithPopup(p).catch(e => {
        const c = (e && e.code) || "";
        if (/operation-not-supported-in-this-environment|web-storage-unsupported/.test(c)) redirect();
        else toApp({ signedIn: false, error: friendly(e) });
      });
    },
    cancelSignIn() { },
    signOut() { liveStop(); clearKept(); const done = () => { auth.signOut(); setSession(null); store.set("psl.web.rem", null); clearKept(); }; dropPush().then(done, done); },
    sha256: s => sha256hex(s),
    version: () => "web " + BUILD,
    save(k, v) { store.set("psl.web.cache." + k, v); },
    load: k => store.get("psl.web.cache." + k) || "",
    reminderSettings: () => JSON.stringify(remSettings()),
    setReminderSettings(json) { store.set("psl.web.rem", json); saveSub().catch(() => { }); },
    testReminder() {
      if (!pushOn()) { enablePush(); return; }
      navigator.serviceWorker.ready.then(reg => reg.showNotification("PSL Master - test reminder",
        { body: "This is how the summary looks. The real one comes at your chosen times, sent by the office PC.", tag: "psl-summary", icon: "icon-192.png", data: { goto: "home" } }))
        .catch(e => tell("Reminders", e.message || String(e)));
    },
    notificationsAllowed: () => pushOn(),
    askNotifications() { enablePush(); },
    openNotificationSettings() { tell("Notifications", "On the iPhone: Settings > Notifications > PSL Master."); },
    openUrl(u) { window.open(u, "_blank", "noopener"); },
    liveStart() { liveStart(); },
    liveStop() { liveStop(); },
    exitApp() { },
    request(id, method, url, headersJson, body, needAuth) { doRequest(id, method, url, headersJson, body, needAuth); }
  };
})();
