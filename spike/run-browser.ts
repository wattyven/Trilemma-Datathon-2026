// Serves browser/index.html with Vite on localhost and runs it in headless Chromium via Playwright.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeOut, SPIKE_DIR } from './lib.ts';

const PORT = 5199;
const server = await createServer({ root: SPIKE_DIR, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
  else console.log('[page]', m.text().slice(0, 400));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

try {
  await page.goto(`http://localhost:${PORT}/browser/index.html`);
  await page.waitForFunction(() => (window as any).__done === true, null, { timeout: 180_000 });
  const results = await page.evaluate(() => (window as any).__results);
  writeOut('browser-results.json', { ...results, consoleErrors });
  console.log('\nConsole errors (CORS failures show up here):');
  for (const e of consoleErrors) console.log('  ' + e.slice(0, 300));
} finally {
  await browser.close();
  await server.close();
}
