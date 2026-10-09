import { defineConfig } from 'vitest/config';
import { analysisChatPlugin } from './src/server/analysisChatPlugin';

// CI passes repository variables even when they're unset (as ""), which would beat .env.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
if (env && !env.VITE_SITE_URL) delete env.VITE_SITE_URL;

// Served from the root of https://vanshade.ca (GitHub Pages with a custom domain).
export default defineConfig({
  plugins: [analysisChatPlugin()],
  base: '/',
  build: { target: 'es2022', sourcemap: true },
  // copc.js imports laz-perf's browser build; we hand it the web-worker build instead (it runs in
  // a module worker, and its .wasm is fetched from our own assets), so bundle only that one.
  resolve: { alias: [{ find: /^laz-perf$/, replacement: 'laz-perf/lib/worker/index.js' }] },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
