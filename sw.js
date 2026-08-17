// Stammtisch — Service Worker
// Cacht die App beim ersten Laden, damit sie danach auch ohne Internet
// startet und funktioniert (die Spiele selbst brauchen ohnehin kein Netz).
const CACHE_NAME = 'stammtisch-v38';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './assets/pf-horse-karo.png',
  './assets/pf-horse-herz.png',
  './assets/pf-horse-pik.png',
  './assets/pf-horse-kreuz.png',
  './assets/pf-trophy.png',
  './assets/pf-crown.png',
  './assets/pf-flag.png',
  './assets/pf-start.png',
  './assets/pf-bus.png',
  './assets/pf-track-bg.png',
  './assets/cover-kc.png',
  './assets/cover-pf.png',
  './assets/cover-bf.png',
  './assets/pf-bus.png',
  './assets/av-adi.png',
  './assets/av-leo.png',
  './assets/av-max.png',
  './assets/av-samu.png',
  './assets/av-tobi.png',
  './assets/av-bocki.png',
  './assets/av-bruno.png',
  './assets/av-leroy.png',
  './assets/cup-gold.png',
  './assets/card-back.png',
  './assets/bg-party.png',
  './assets/turf.png',
  './assets/kc-bg.jpg',
  './assets/loading/ls-bg.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Jede Datei einzeln cachen: fehlt eine (z.B. ein optionales Asset),
      // blockiert das nicht das Cachen aller anderen Dateien.
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline -> Fallback auf den Cache
      return cached || network;
    })
  );
});
