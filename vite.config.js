import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'docs',
    sourcemap: true
  },
  worker: {
    // The wasm converters' glue code uses import.meta.url, which needs module workers
    format: 'es'
  },
  base: '/tools/'
});