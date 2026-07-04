/* Rootwork service worker — stale-while-revalidate so the home-screen (PWA)
 * app renders INSTANTLY from cache (no black launch flash / network wait) yet
 * still self-updates: each request is served from cache immediately while a
 * fresh copy is fetched in the background and stored for next launch. Since
 * CSS/JS/data are ?v=-versioned, their new URLs miss the cache and fetch fresh
 * right away; only the unversioned shell (index.html) lags one launch, the
 * standard PWA cadence. Bump CACHE to force a clean re-fetch. */
"use strict";
const CACHE = "rootwork-v2";

self.addEventListener("install", function () {
  self.skipWaiting(); // activate this SW immediately, don't wait for old tabs
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // only handle our own origin; let cross-origin (Wikipedia, commons audio) pass
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req).then(function (cached) {
        const network = fetch(req)
          .then(function (res) { if (res && res.ok) cache.put(req, res.clone()); return res; })
          .catch(function () { return cached; });
        // serve cache instantly if we have it; otherwise wait for the network
        return cached || network;
      });
    })
  );
});
