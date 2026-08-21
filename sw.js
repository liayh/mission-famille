/* Service worker — sert la coquille de l'app à jour dès qu'il y a du réseau, et ne se
   rabat sur le cache que hors-ligne (au lieu de resservir une version périmée).
   Incrémenter CACHE_NAME lors d'un changement de fichiers pour forcer la mise à jour. */
const CACHE_NAME = 'mission-famille-v3';
const APP_SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // { cache: 'no-store' } force le navigateur à vraiment interroger le réseau, plutôt que
  // de servir silencieusement une réponse depuis SON PROPRE cache HTTP (indépendant du
  // Cache Storage ci-dessus) — sans ça, "réseau d'abord" pouvait quand même resservir une
  // version périmée d'app.js déjà en cache navigateur, sans jamais toucher le réseau.
  const freshRequest = new Request(event.request, { cache: 'no-store' });
  event.respondWith(
    fetch(freshRequest)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
