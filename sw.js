// VGC 戦績トラッカー Service Worker — アプリ本体＋スプライトをキャッシュして完全オフライン化
const SHELL = 'vgc-shell-v4';
const SPRITES = 'vgc-sprites-v1';
const SHELL_ASSETS = [
  './', './index.html', './pokedex-names.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== SPRITES).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Showdownスプライト: cache-first（初回オンライン取得→以後オフラインでも表示）
  if (url.hostname.includes('pokemonshowdown.com')) {
    e.respondWith(
      caches.open(SPRITES).then(async cache => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          cache.put(e.request, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })
    );
    return;
  }
  // 同一オリジン: cache-first（オフラインでアプリ起動可）
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => hit))
    );
  }
});
