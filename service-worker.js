const CACHE_NAME = 'sana-cache-v42';
const ARCHIVOS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Las rutas /api/ nunca deben servirse desde caché: siempre van directo
  // a la red para evitar que una respuesta vieja (o el index.html) se
  // devuelva como si fuera la respuesta real del servidor.
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // El documento principal (index.html / la ruta raíz) siempre se pide
  // primero a la red, para que los deploys nuevos se vean de inmediato.
  // Si no hay conexión, se cae de respaldo a la copia en caché.
  const esDocumentoPrincipal =
    event.request.mode === 'navigate' ||
    event.request.url.endsWith('/') ||
    event.request.url.endsWith('/index.html');

  if (esDocumentoPrincipal) {
    event.respondWith(
      fetch(event.request)
        .then((respuesta) => {
          const copia = respuesta.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
          return respuesta;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((respuesta) => {
      return respuesta || fetch(event.request).catch(() => caches.match('./index.html'));
    })
  );
});
