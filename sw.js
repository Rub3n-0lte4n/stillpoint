/* Stillpoint service worker — makes the app fully usable offline.
   The app shell + vendored parsers are precached; Google Fonts are cached at
   runtime. Books are stored locally in IndexedDB (see js/store.js), so once you've
   opened the app online, both it and your library work with no connection.
   Bump CACHE_VERSION whenever shell files change so clients pick up the update. */
const CACHE_VERSION = "stillpoint-v43";
const FONT_CACHE = "stillpoint-fonts-v1";

// All paths are relative to this file (served at /stillpoint/sw.js).
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "js/app.js",
  "js/text.js",
  "js/haptics.js",
  "js/parsers.js",
  "js/store.js",
  "js/blockmode.js",
  "js/highlights.js",
  "js/patron.js",
  "js/streak.js",
  "js/gestures.js",
  "js/hints.js",
  "js/vendor/pdf.min.js",
  "js/vendor/pdf.worker.min.js",
  "js/vendor/jszip.min.js",
  "favicon.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // cache:"reload" bypasses the browser's HTTP cache at install, so a new shell
    // version can never be assembled from mixed-age files (fresh HTML, stale JS)
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION && k !== FONT_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Web Share Target: another app shares a PDF/EPUB to Stillpoint (Android).
  // Stash the file in the app's IndexedDB, then land on the app, which opens it
  // (see the shared::pending pickup in js/app.js init).
  if (req.method === "POST" && url.origin === self.location.origin && url.pathname.endsWith("/share-target")) {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get("book");
        if (file && file.size) await idbPutShared({ file, name: file.name || "Shared file", ts: Date.now() });
      } catch (e) { /* fall through; the app just opens normally */ }
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }

  if (req.method !== "GET") return;

  // Google Fonts (CSS + font files): cache-first, populate on first online load.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(FONT_CACHE).then((cache) =>
        cache.match(req).then((hit) =>
          hit || fetch(req).then((res) => { cache.put(req, res.clone()); return res; })
        )
      )
    );
    return;
  }

  // Same-origin app shell: cache-first, fall back to network.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req)
          .then((res) => {
            // Cache successful same-origin GETs we didn't precache (defensive).
            if (res && res.ok && res.type === "basic") {
              const copy = res.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => {
            // Offline & not cached: serve the app shell for navigations.
            if (req.mode === "navigate") return caches.match("index.html");
          });
      })
    );
  }
});

// Minimal IndexedDB access matching js/store.js (db "stillpoint" / store "files").
// The SW can't import that ES module, so the two definitions must stay in sync.
function idbPutShared(rec) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("stillpoint", 1);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains("files")) d.createObjectStore("files");
    };
    open.onsuccess = () => {
      const t = open.result.transaction("files", "readwrite");
      t.objectStore("files").put(rec, "shared::pending");
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    };
    open.onerror = () => reject(open.error);
  });
}
