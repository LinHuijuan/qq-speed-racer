import { defineConfig } from 'vite';

export default defineConfig({
  // 相对 base：便于部署到 GitHub Pages 项目子路径（/<repo>/）
  base: './',
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
