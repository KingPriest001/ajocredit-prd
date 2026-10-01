/* AJOCREDIT PWA — app-shell offline cache */
const VERSION = "ajo-v1";
const SHELL = [
  "./",
  "./landing.html",
  "./index.html",
  "./offline.html",
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
