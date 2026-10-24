/* Makes SMD installable: registers the service worker and shows an "Install app" button when the browser allows it. */
(function () {
  if ("serviceWorker" in navigator) window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  var deferred = null, btns = function () { return document.querySelectorAll(".installBtn"); }, hints = function () { return document.querySelectorAll(".iosHint"); };
  function show(on) { btns().forEach(function (b) { b.style.display = on ? "inline-block" : "none"; }); }
  if (standalone) { show(false); return; } /* already installed and running as the app */
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; show(true); });
  window.addEventListener("appinstalled", function () { deferred = null; show(false); });
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".installBtn"); if (!b || !deferred) return;
    deferred.prompt(); deferred.userChoice.finally(function () { deferred = null; show(false); });
  });
  if (ios) hints().forEach(function (h) { h.style.display = "block"; }); /* iPhones have no install button: show the Share → Add to Home Screen tip */
})();
