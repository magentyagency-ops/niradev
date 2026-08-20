import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  server: {
    port: 5200,
    strictPort: true,
    // Les fonctions `api/` tournent en local derrière un petit serveur Express
    // (npm run dev:api) : en production, Vercel sert exactement les mêmes fichiers.
    proxy: {
      '/api': { target: 'http://127.0.0.1:5201', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      input: resolve(root, 'index.html'),
    },
  },
})
