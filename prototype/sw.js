/* AJOCREDIT PWA — app-shell offline cache */
const VERSION = "ajo-v6";
const SHELL = [
  "./",
  "./landing.html",
  "./index.html",
  "./offline.html",
  "./terms.html",
  "./privacy.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./photos/trader-hero.jfif",
  "./photos/market-peppers.jfif",
  "./photos/trader-yams.jfif",
  "./photos/coop-cash.jfif",
  "./photos/trader-smile.jfif",
  "./photos/young-pro.jfif",
  "./photos/coop-group.jfif",
  "./photos/pro-office-man.jfif",
  "./photos/pro-phone-woman.jfif",
  "./photos/pro-phone-man.jfif"
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Never touch cross-origin traffic (API, PSP, analytics).
  if (url.origin !== self.location.origin) return;
  // The app shell (the HTML the app runs from) must ALWAYS be fresh: we ship new
  // features often and a cache-first shell would pin users to an old build for ever
  // (the cache name only changes when this file changes). Network-first, with the
  // cache as the offline fallback. Photos/icons stay cache-first below.
  const isShell = e.request.mode === "navigate" || /\/index\.html$/.test(url.pathname);
  if (isShell) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(e.request, { ignoreSearch: true })
            .then((hit) => hit || caches.match("./index.html"))
            .then((hit) => hit || caches.match("./offline.html"))
        )
    );
    return;
  }
  // Static assets: cache-first, so photos and icons load instantly and work offline.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
          return res;
        }).catch(() => caches.match("./offline.html"))
    )
  );
});
