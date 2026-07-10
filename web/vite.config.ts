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
  build: {
    // Multi-page: the console (index.html) + the standalone terminal test bed (termbed.html).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        termbed: fileURLToPath(new URL('./termbed.html', import.meta.url)),
      },
    },
  },
  // Dev only: proxy API + terminal to the running agent-os server.
  server: {
    host: '127.0.0.1',
    // Allow the Tailscale hostname so `tailscale serve` (HTTPS) can front the test bed for remote access.
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': 'http://localhost:3010',
      '/health': 'http://localhost:3010',
      '/terminal': { target: 'http://localhost:3011', ws: true },
      // Test bed: proxy the throwaway ttyd started by scripts/termbed.mjs.
      '/pty': { target: 'http://localhost:7699', ws: true },
    },
  },
})
