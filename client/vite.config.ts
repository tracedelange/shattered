import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
      '/tilesets':  { target: 'http://localhost:3000', changeOrigin: true },
      '/api':       { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
