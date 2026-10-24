/* SMD service worker. Deliberately tiny and safe for an app with logins and payments:
   it never stores pages, API answers or anything personal. It only keeps the offline screen and the icon,
   and shows the offline screen when the phone has no connection. */
const CACHE = "smd-offline-v1", KEEP = ["/offline.html", "/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(KEEP)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.mode !== "navigate") return; /* everything else (API, scripts, images) goes straight to the network */
  e.respondWith(fetch(r).catch(() => caches.match("/offline.html")));
});
