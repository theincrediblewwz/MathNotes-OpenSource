import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icons/mathnotes-192.png", "icons/mathnotes-512.png"],
      manifest: {
        name: "MathNotes",
        short_name: "MathNotes",
        description: "MathNotes 手机独立工作区与电脑伴侣端",
        lang: "zh-CN",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#fbfaf7",
        theme_color: "#fbfaf7",
        icons: [
          { src: "/icons/mathnotes-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icons/mathnotes-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
        ]
      },
      workbox: {
        sourcemap: false,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/local\//, /^\/v1\//],
        globPatterns: ["**/*.{html,js,css,png,svg,woff2,webmanifest}"]
      }
    })
  ],
  build: {
    target: "es2022",
    sourcemap: false
  }
});
