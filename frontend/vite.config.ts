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
      // Service worker maison (src/sw.ts) : précache, navigation hors ligne, notifications push. La mise à jour
      // est proposée par un bandeau (registerType prompt) plutôt qu'appliquée au milieu d'une saisie.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
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
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  envDir: '..',
  // host: true expose le serveur de dev sur le réseau local (test depuis un autre appareil).
  server: { port: 5173, host: true },
});
