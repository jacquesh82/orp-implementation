/**
 * PURGE service worker of the former application (/app/, withdrawn: only the
 * Studio /studio/ remains). A browser that had opened the app keeps its service
 * worker, which served its cached copy; on the next visit it rechecks this
 * file, installs it, and this one empties the caches, unregisters itself and
 * sends the open pages to the Studio.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((c) => c.startsWith("optirelay-")).map((c) => caches.delete(c)));
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: "window" });
      for (const win of windows) void win.navigate(new URL("../studio/", self.registration.scope).href);
    })(),
  );
});
