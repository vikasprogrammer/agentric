import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Dev only: proxy API + terminal to the running agent-os server.
  server: {
    proxy: {
      '/api': 'http://localhost:3010',
      '/health': 'http://localhost:3010',
      '/terminal': { target: 'http://localhost:3011', ws: true },
    },
  },
})
