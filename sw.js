'use strict';
/*
 * Service worker : app shell hors ligne.
 *
 * Un seul cache, versionné par build (data/precache.json) : page, scripts,
 * styles, glyphes, sprites, icônes, petits JSON. Les gros paquets de données
 * (data/fond/, data/contexte/, data/topo/, data/relief/, data/adresses/)
 * ne passent JAMAIS par ici : ils vivent dans l'OPFS (stockage.js) et se
 * lisent par plages d'octets, ce que le Cache Storage ne sait pas servir.
 */
const PREFIXE = 'soest-app-';
/* Identifiant de build, réécrit par build/manifeste.py : le navigateur ne
   réinstalle un service worker que si son script a changé d'un octet. Sans
   cette ligne, une nouvelle version (nouveau precache.json) resterait
   invisible des appareils déjà installés. */
const BUILD = '2026-11-01-1708';
let APP_CACHE = PREFIXE + 'initial';
const PAQUETS = /\/data\/(fond|contexte|topo|relief|adresses)\//;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const reponse = await fetch('data/precache.json', { cache: 'reload' });
    const { build, fichiers } = await reponse.json();
    APP_CACHE = PREFIXE + (build || BUILD);
    const cache = await caches.open(APP_CACHE);
    // `cache: 'reload'` contourne le cache HTTP : sinon addAll() peut figer une
    // version périmée (GitHub Pages sert max-age=600).
    await cache.addAll(fichiers.map((u) => new Request(u, { cache: 'reload' })));
    /* Pas de skipWaiting() ici : la version est prête mais attend le feu vert
       de miseajour.js (clic sur le bandeau). Tant qu'elle attend, l'ancienne
       sert et son cache n'est pas effacé sous une page ouverte. */
  })());
});

self.addEventListener('message', (e) => {
  const message = e.data || {};
  if (message.type === 'passer-devant') self.skipWaiting();
  if (message.type === 'version' && e.ports && e.ports[0]) {
    cacheActuel().then(() => e.ports[0].postMessage({ version: APP_CACHE.slice(PREFIXE.length) }));
  }
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    /* Le worker a pu être arrêté entre install et activate (inactif tant que le
       bandeau attendait un clic) : APP_CACHE serait retombé à 'initial' et le
       ménage ci-dessous effacerait aussi le cache qui vient d'être rempli. */
    await cacheActuel();
    const cles = await caches.keys();
    await Promise.all(cles.filter((k) => k.startsWith(PREFIXE) && k !== APP_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const request = e.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PAQUETS.test(url.pathname)) return; // Range direct, jamais mis en cache
  if (request.mode === 'navigate') { e.respondWith(navigation(request)); return; }
  const lourd = /\/(lib|assets|icons)\//.test(url.pathname);
  e.respondWith(lourd ? cacheDabord(request) : reseauDabord(request));
});

async function cacheActuel() {
  if (APP_CACHE === PREFIXE + 'initial') {
    // worker relancé : retrouve le cache du build courant
    const cles = (await caches.keys()).filter((k) => k.startsWith(PREFIXE));
    if (cles.length) APP_CACHE = cles.sort().pop();
  }
  return caches.open(APP_CACHE);
}

async function cacheDabord(request) {
  const cache = await cacheActuel();
  const encache = await cache.match(request, { ignoreSearch: true });
  if (encache) return encache;
  const reponse = await fetch(request);
  if (reponse.ok) cache.put(request, reponse.clone());
  return reponse;
}

async function reseauDabord(request) {
  const cache = await cacheActuel();
  try {
    const reponse = await fetch(request, { cache: 'no-cache' });
    if (reponse.ok) { cache.put(request, reponse.clone()); return reponse; }
    return (await cache.match(request, { ignoreSearch: true })) || reponse;
  } catch (err) {
    const encache = await cache.match(request, { ignoreSearch: true });
    if (encache) return encache;
    throw err;
  }
}

async function navigation(request) {
  const cache = await cacheActuel();
  try {
    const reponse = await fetch(request);
    if (reponse.ok) cache.put('index.html', reponse.clone());
    return reponse;
  } catch (err) {
    const secours = await cache.match('index.html');
    if (secours) return secours;
    throw err;
  }
}
