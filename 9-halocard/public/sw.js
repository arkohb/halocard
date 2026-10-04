/* HaloCard service worker — version is stamped by the server from changelog.json,
   so every release installs a fresh cache and the app shows "Update ready". */
const VERSION = "__VERSION__";
const CACHE = "halocard-" + VERSION;
const CORE = ["/", "/login", "/register", "/app", "/app.css", "/manifest.webmanifest", "/offline.html",
  "/vendor/qrcode.js", "/vendor/jspdf.umd.min.js",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png", "/icons/favicon-32.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  /* first install activates straight away; later versions wait for the user to tap "Refresh" */
  if (!self.registration.active) self.skipWaiting();
});
self.addEventListener("message", (e) => { if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("halocard-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  /* always live: API, public card pages, vCards, health, release notes */
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/c/") || url.pathname === "/health" || url.pathname === "/changelog.json") return;
  /* pages: network first (always the newest app), cached copy or offline page when there is no internet */
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("/offline.html"))));
    return;
  }
  /* files: cache first, refreshed in the background */
  e.respondWith(caches.match(req).then((cached) => {
    const net = fetch(req).then((res) => { if (res && res.status === 200 && res.type === "basic") { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)); } return res; }).catch(() => cached);
    return cached || net;
  }));
});
