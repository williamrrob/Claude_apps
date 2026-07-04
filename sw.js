/* Rootwork service worker — network-first so the home-screen (PWA) app
 * self-updates: every launch tries the network (picking up new index.html,
 * CSS, JS, and versioned data), and falls back to the cache only when
 * offline. This is what lets the installed app update without deleting and
 * re-adding it. Bump CACHE when the caching strategy itself changes. */
"use strict";
const CACHE = "rootwork-v1";

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
    fetch(req)
      .then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () { return caches.match(req); })
  );
});
