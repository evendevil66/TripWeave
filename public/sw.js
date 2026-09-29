const CACHE = 'trip-shell-v2'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/_AMapService/')) return
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put('/', response.clone()))
      return response
    }).catch(() => caches.match('/')))
    return
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && url.pathname.startsWith('/assets/')) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()))
    return response
  })))
})
