/**
 * Service Worker for Skyroom PWA.
 * Strategy:
 *   - App shell: stale-while-revalidate
 *   - Same-origin static: cache-first with background update
 *   - Cross-origin (skyroom itself): network-only, no cache (handled by Skyroom's own SW/CDN)
 */

const CACHE_VERSION = 'v1.2.0';
const SHELL_CACHE = `skyroom-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `skyroom-static-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './room.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/room.js',
  './js/storage.js',
  './js/notifications.js',
  './js/capabilities.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: 'reload' })))
    ).then(() => self.skipWaiting()).catch((e) => console.warn('SW install failed', e))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== STATIC_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin only.
  if (url.origin !== location.origin) return;

  // App shell pages: network-first, fallback to cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Static assets: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Receive messages from clients for cache management
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});

// Basic push handler for future enhancements.
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'کلاس اسکای‌روم', {
      body: data.body || 'کلاس شما شروع شد!',
      icon: './icons/icon-192.png',
      badge: './icons/icon-72.png',
      dir: 'rtl',
      lang: 'fa-IR',
      data: data.url ? { url: data.url } : {},
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || './index.html';
  event.waitUntil(clients.matchAll({ type: 'window' }).then((wins) => {
    for (const w of wins) {
      if (w.url.includes(url)) return w.focus();
    }
    return clients.openWindow(url);
  }));
});