// Somente arquivos da interface entram neste cache; respostas autenticadas nunca entram.
const VERSION = '20261106offline2';
const PREFIX = `dolarmap-offline-shell:${self.registration.scope}:`;
const CACHE = PREFIX + VERSION;
const base = self.registration.scope;
// A raiz evita guardar o redirecionamento de /index.html feito por cleanUrls da Vercel.
const shellURL = base;
const resources = [
  './', 'manifest.webmanifest', 'css/app.css?v=' + VERSION,
  ...['main', 'config', 'store', 'supabase', 'logic', 'analytics', 'achievements', 'offline-db', 'offline-store', 'offline']
    .map((name) => `js/${name}.js?v=${VERSION}`),
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
].map((path) => new URL(path, base).href);
const resourceURLs = new Set(resources);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(resources.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const root = new URL(base).pathname;
  if (request.mode === 'navigate' && [root, root + 'index.html'].includes(url.pathname)) {
    // Rede primeiro: publicar a versão antiga no mesmo endereço continua funcionando.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(request, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Aplicativo indisponível');
        await cache.put(shellURL, response.clone());
        return response;
      } catch {
        return (await cache.match(shellURL)) || Response.error();
      } finally { clearTimeout(timeout); }
    })());
    return;
  }
  if (!resourceURLs.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(request)) || fetch(request);
  })());
});
