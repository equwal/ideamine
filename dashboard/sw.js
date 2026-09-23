// The service worker of the dashboard on a phone. It keeps the page and its icons, so that the app
// opens when the tunnel to the server is down. The archive, the prompts, and the memories always
// come from the server: a copy of them would show old ideas as if they were current.
//
// A browser starts a service worker only on https or on localhost, so the page registers it only
// there. Without it the page still works; it only needs the network each time.

const CACHE = 'ideamine-shell-v1';
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

const live = (url) => url.pathname.endsWith('/data.json') || url.pathname.includes('/api/') || url.pathname.includes('/v1/');

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || live(url)) return; // the server answers
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('./'))),
  );
});
