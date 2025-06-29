const CACHE_NAME = 'yearbook-cache-v1';

self.addEventListener('install', event => {
  self.skipWaiting(); // Activate immediately after install
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.map(key => {
        if (key !== CACHE_NAME) {
          return caches.delete(key); // Delete old caches
        }
      }))
    )
  );
});

self.addEventListener('fetch', event => {
  // Only cache GET requests (images, CSS, JS, etc.)
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Optional: Only cache images
        if (event.request.destination === 'image') {
          return caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, response.clone());
            return response;
          });
        } else {
          return response;
        }
      }).catch(() => {
        // Offline fallback (optional)
        return caches.match('/images/fallback.jpg');
      });
    })
  );
});
