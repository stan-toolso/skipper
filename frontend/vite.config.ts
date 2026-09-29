import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Application installable (Android, iPhone, bureau) : manifeste + service worker qui met en
    // cache la coquille de l'application et se met à jour seul. Les appels API et les WebSockets ne
    // passent jamais par le cache.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'logo-mark.svg', 'logo-mark-dark.svg', 'logo-mark-mono.svg'],
      manifest: {
        name: 'Skipper',
        short_name: 'Skipper',
        description: "Pilotage de sessions d'agents (Claude Code) en arrière-plan",
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#141414',
        theme_color: '#0f0f0f',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Les routes de l'application renvoient index.html ; tout ce qui est serveur (API, WebSocket,
        // authentification) est exclu.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/graphql/, /^\/terminals\//, /^\/auth\//, /^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  envDir: '..',
  // host: true expose le serveur de dev sur le réseau local (test depuis un autre appareil).
  server: { port: 5173, host: true },
});
