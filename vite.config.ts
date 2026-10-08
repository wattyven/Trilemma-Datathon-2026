import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site under /<repo>/.
export default defineConfig({
  base: '/VanShade/',
  build: { target: 'es2022', sourcemap: true },
  // copc.js imports laz-perf's browser build; we hand it the web-worker build instead (it runs in
  // a module worker, and its .wasm is fetched from our own assets), so bundle only that one.
  resolve: { alias: [{ find: /^laz-perf$/, replacement: 'laz-perf/lib/worker/index.js' }] },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
