import { defineConfig } from 'vite'

import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/': {
        target: 'http://127.0.0.1:4097',
        // Preserve the browser's Host and Origin so the backend can compare them directly.
        changeOrigin: false,
      },
    },
  },
})
