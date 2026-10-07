import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site under /<repo>/.
export default defineConfig({
  base: '/VanShade/',
  build: { target: 'es2022', sourcemap: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
