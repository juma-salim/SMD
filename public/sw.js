"use strict";
/* Minimal service worker: makes SMD installable as an app.
   It deliberately caches NOTHING and passes every request straight to the network, so logins, sessions,
   deliveries and ID photos are never stored on the phone and the app is always up to date. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; /* let the browser handle posts, uploads, etc. normally */
  e.respondWith(
    fetch(e.request).catch(() =>
      e.request.mode === "navigate"
        ? new Response(
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>SMD</title>" +
              "<body style='font-family:system-ui;text-align:center;padding:48px 24px'><h2>You are offline</h2>" +
              "<p>Check your internet connection, then reopen SMD.</p></body>",
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
          )
        : Response.error()
    )
  );
});
