// Service worker: кэширует только оболочку приложения. Данные API и тайлы карты НЕ кэшируются,
// чтобы старые сведения никогда не выдавались за актуальные.
const VERSION = 'wl-shell-v2';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/config.js', 'js/icons.js', 'js/tg.js', 'js/i18n.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon.svg', 'impressum.html', 'datenschutz.html'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // CDN, тайлы, API — напрямую из сети
  if (url.pathname.includes('/admin')) return;          // админку не кэшируем
  // «сначала сеть, при отсутствии — кэш»: обновления кода подхватываются сразу
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});
