/** @type {import('next').NextConfig} */
const nextConfig = {
  // PWA の Service Worker / manifest は public/ と app/manifest.ts で提供する。
  // API ルート個別の maxDuration は各 route.ts の `export const maxDuration` で指定。
};

module.exports = nextConfig;
