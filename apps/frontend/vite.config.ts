import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@tracker/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/health': 'http://localhost:37801',
      '/api': 'http://localhost:37801',
      '/auth': { target: 'http://localhost:37801', changeOrigin: true },
      '/me': 'http://localhost:37801',
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/health': 'http://localhost:37801',
      '/api': 'http://localhost:37801',
      '/auth': { target: 'http://localhost:37801', changeOrigin: true },
      '/me': 'http://localhost:37801',
    },
  },
})
