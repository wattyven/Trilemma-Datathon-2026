// One smoke test of the deployed flow, plus a mobile layout check.
//   BASE_URL=https://vanshade.ca/ npx playwright test   (CI does this after deploy)
//   npx playwright test                                                  (against `vite --port 5180`)
import { defineConfig, devices } from '@playwright/test';

const swiftshader = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }; // WebGL in headless runs

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  retries: process.env.CI ? 1 : 0, // live government APIs: allow one retry for a network blip
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5180/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', grepInvert: /@mobile/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, launchOptions: swiftshader } },
    { name: 'mobile', grep: /@mobile/, use: { ...devices['Pixel 7'], launchOptions: swiftshader } },
  ],
});
