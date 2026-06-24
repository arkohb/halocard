const CACHE = "halocard-v1";
const CORE = ["/", "/index.html", "/app", "/app.html", "/app.css", "/manifest.webmanifest",
  "/vendor/qrcode.js", "/vendor/jspdf.umd.min.js",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // always live: API, dynamic profiles + vCard, health
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/c/") || url.pathname === "/health") return;
  if (req.mode === "navigate") { e.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || caches.match("/index.html")))); return; }
  e.respondWith(caches.match(req).then((cached) => {
    const net = fetch(req).then((res) => { if (res && res.status === 200 && res.type === "basic") { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)); } return res; }).catch(() => cached);
    return cached || net;
  }));
});
