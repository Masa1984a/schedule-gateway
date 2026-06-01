// 最小 Service Worker。
// 目的は「ホーム画面に追加（PWA インストール要件）」を満たすこと。
// チャットは常にオンライン前提なので API はキャッシュしない（network-first / 素通し）。

const CACHE = "schedule-gateway-v1";
const SHELL = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API・非 GET は常にネットワーク（オフラインキャッシュしない）。
  if (request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  // それ以外は network-first、失敗時にキャッシュへフォールバック。
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match("/"))),
  );
});
