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
      '/health': 'http://127.0.0.1:37801',
      '/api': 'http://127.0.0.1:37801',
      '/me': 'http://127.0.0.1:37801',
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/health': 'http://127.0.0.1:37801',
      '/api': 'http://127.0.0.1:37801',
      '/me': 'http://127.0.0.1:37801',
    },
  },
})
