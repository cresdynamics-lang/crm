/**
 * Cres OS service worker: makes the app installable and keeps the shell
 * opening when the network is slow or down.
 *
 *  - API calls and socket traffic are never cached (always live data).
 *  - Pages, scripts and styles: network first, cached copy if offline.
 *  - Icons, fonts, images: cache first.
 */
const VERSION = 'cres-os-20261109d';
const SHELL = ['/login', '/dashboard', '/css/tokens.css', '/icons/cres-os-192.png', '/brand/logo.png', '/offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Google Fonts: cache first
    if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) event.respondWith(cacheFirst(req));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/uploads/')) return;

  if (/\.(png|jpe?g|svg|webp|ico|woff2?|mp3)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
    }
    return res;
  } catch {
    const hit = await caches.match(req, { ignoreSearch: req.mode !== 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await caches.match('/offline.html')) || Response.error();
    return Response.error();
  }
}
