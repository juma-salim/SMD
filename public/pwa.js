"use strict";
/* Registers the service worker so SMD can be installed as an app. Kept in its own file because the
   server's Content-Security-Policy does not allow inline scripts. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {}); /* never break the app if this fails */
  });
}
