/**
 * Service worker of the reference PWA (F-26, D-011): the transfer works
 * WITHOUT network once the app is loaded. No external request, no
 * telemetry: everything cached comes from this origin.
 *
 * Strategies:
 *   - pages (index.html) and files WITHOUT fingerprint: network first, cache
 *     as offline fallback. Never the reverse: an index.html served from the
 *     cache after a redeployment points to bundles that no longer exist (404,
 *     dead page);
 *   - fingerprinted files (assets/, immutable): cache first;
 *   - only 200 responses are kept — a cached 404 would stay forever.
 */

const CACHE = "optirelay-v0.2.0";
const APP_SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

function keep(request, response) {
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    void caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.includes("/assets/")) {
    // Fingerprint in the name: the content never changes.
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((r) => keep(request, r))));
    return;
  }

  // Network first, cache as offline fallback. No options to fetch: a
  // navigation request does not accept them (TypeError → always the cache);
  // nginx already serves the pages with "Cache-Control: no-cache".
  event.respondWith(
    fetch(request)
      .then((r) => keep(request, r))
      .catch(() =>
        caches
          .match(request)
          .then((cached) => cached ?? (request.mode === "navigate" ? caches.match("./index.html") : undefined))
          .then((r) => r ?? Response.error()),
      ),
  );
});
