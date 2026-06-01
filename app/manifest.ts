import type { MetadataRoute } from "next";

// /manifest.webmanifest として配信される（Next の metadata route）。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Schedule Gateway",
    short_name: "Schedule",
    description: "スケジュール管理エージェントの窓口",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0f17",
    theme_color: "#0b0f17",
    lang: "ja",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
