"use strict";
/* PSL Master web app - the service worker: keeps the app's own files for offline starts, and shows the reminder the admin
   PC pushes (one summary, replacing the previous one). Database, sign-in and Google's files always go to the network. */
const VERSION = "2026.10.12.1642";
const CACHE = "psl-" + VERSION;
const SHELL = ["./", "index.html", "app.css?v=" + VERSION, "app.js?v=" + VERSION, "engine.js?v=" + VERSION, "web-native.js?v=" + VERSION, "guard.js?v=" + VERSION, "desktop.js?v=" + VERSION, "desktop.css?v=" + VERSION,
  "logo.png", "icon-192.png", "apple-touch-icon.png", "manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin || u.pathname.indexOf("/__/") === 0) return;
  // the newest version when online, the kept copy when not
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match(e.request, { ignoreSearch: true })).then(r => r || caches.match("index.html"))));
});

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "PSL Master", {
    body: d.body || "Open PSL Master to see what is new.",
    tag: d.tag || "psl-summary",            // replaces the previous summary - never a pile of them
    renotify: !!d.sound,
    silent: !d.sound,
    icon: "icon-192.png",
    badge: "badge-96.png",
    data: { goto: d.goto || "home" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const go = (e.notification.data && e.notification.data.goto) || "home";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) { c.postMessage({ goto: go }); return c.focus(); }
    return self.clients.openWindow("./?goto=" + encodeURIComponent(go));
  }));
});
