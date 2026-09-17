import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5190,
    strictPort: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 4190,
    strictPort: false,
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
