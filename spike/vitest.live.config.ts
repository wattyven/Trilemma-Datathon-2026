// Opt-in live checks against the real data services: npx vitest run --config spike/vitest.live.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['spike/**/*.live.test.ts'], environment: 'node', testTimeout: 180_000 },
});
