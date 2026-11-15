// Offline-first app shell, network-first news feed; bounded cache keys.
const CACHE = 'mynews-v5';
const ASSETS = ['./', './index.html', './style.css', './app.js', './reader-core.js', './reader.js', './reader-help.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mynews-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin || !new URL(event.request.url).pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  const u = new URL(event.request.url);
  const isNews = u.pathname.endsWith('/data/news.json');
  const cacheKey = isNews ? new Request(u.origin + u.pathname) : event.request;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(cacheKey, copy)));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(cacheKey);
    if (cached) {
      if (!isNews) return cached;
      const headers = new Headers(cached.headers);
      headers.set('X-MyNews-Cache', 'offline');
      return new Response(cached.body, {status: cached.status, statusText: cached.statusText, headers});
    }
    if (event.request.mode === 'navigate') return caches.match('./index.html');
    return Response.error();
  }));
});
