import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Build/test configuration.
 *
 * The service worker is deliberately `registerType: 'prompt'`: a lab machine must never
 * reload itself because a new version was deployed while a student is mid-exam. The app
 * only offers the update when no attempt is in progress (see `ui/hooks/useAppUpdate.ts`).
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null, // registered by hand in src/pwa/register.ts
      includeAssets: ['favicon.svg', 'icons/*.png', 'offline.html'],
      manifest: {
        id: '/',
        name: 'ShuleSoft Exams (Offline)',
        short_name: 'ShuleSoft Exams',
        description:
          'Sit ShuleSoft online exams in a computer lab with the internet switched off; answers sync when it comes back.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        categories: ['education'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The whole shell is precached: with the lab switch off, a refresh must still boot.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        cleanupOutdatedCaches: true,
        clientsClaim: false, // never take over a page running an exam
        skipWaiting: false,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            // Question media is downloaded into OPFS/IndexedDB at bundle time; this is a
            // second belt for anything rendered straight from a URL.
            urlPattern: ({ url }) => /\/storage\/uploads\//.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'exam-media',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false, // a dev SW confuses offline testing; use `npm run build && npm run preview`
      },
    }),
  ],
  server: {
    port: 5180,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          dexie: ['dexie', 'dexie-react-hooks'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/*.test.ts'],
    },
  },
});
