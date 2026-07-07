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
      '/health': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/me': 'http://localhost:3000',
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/health': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/me': 'http://localhost:3000',
    },
  },
})
