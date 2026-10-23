const CACHE = 'fod-v5';
const PRECACHE = [
  '/',
  '/index.html',
  '/customer.html',
  '/driver.html',
  '/admin.html',
  '/shopee-driver.html',
  '/styles.css',
  '/common.js',
  '/customer.js',
  '/driver.js',
  '/admin.js',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png'
];

const SKIP = [
  '/socket.io',
  '/swagger-ui',
  '/docs',
  '/openapi.json',
  '/webhooks/',
  '/orders',
  '/drivers',
  '/batches',
  '/metrics',
  '/audit',
  '/payments',
  '/dispatch',
  '/integrations/'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function shouldBypass(url) {
  return SKIP.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix));
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const fallback = await caches.match('/');
    if (fallback) return fallback;
    return new Response('ออฟไลน์ — ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached || (await network) || Response.error();
}

self.addEventListener('push', (event) => {
  let payload = { title: 'มีงานใหม่', body: 'เปิดแอปเพื่อดูรายละเอียด', url: '/driver.html' };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch (_error) {
    // keep the default notification when the payload is empty
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: payload.tag,
      data: { url: payload.url || '/driver.html' },
      vibrate: [200, 100, 200],
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/driver.html';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if (client.url.includes(new URL(target, self.location.origin).pathname)) {
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || shouldBypass(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
