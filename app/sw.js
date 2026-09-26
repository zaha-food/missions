/* Missions — service worker.
   The iPad is mounted on a wall and must open even with no signal.
   Caches the shell so the app always starts; data is handled by the
   queue in app.js, not here. */

const CACHE = 'missions-v12';
const SHELL = [
  './',
  './index.html',
  './app.js?v=12',
  '../config.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // never cache the database — stale checks would be worse than none
  if (url.hostname.endsWith('.supabase.co')) return;
  if (e.request.method !== 'GET') return;

  // network first so a reachable server always wins, cache as the
  // fallback that makes a cold start work with no signal
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r && r.status === 200) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
