// The "Elevation data" choice in the browser: best of both, newest, most detailed, and the change
// overlay, with switch timings and screenshots.  node spike/21-elevation-modes.ts [base url] [address]
import { chromium } from 'playwright';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { OUT_DIR } from './lib.ts';

const base = process.argv[2] ?? 'http://localhost:5181/VanShade/';
const address = process.argv[3] ?? '410 W Georgia St, Vancouver';
const key = address.split(',')[0]!.toLowerCase().replace(/[^a-z0-9]+/g, '-');
mkdirSync(OUT_DIR, { recursive: true });
const RESULT = '.scene-canvas[data-state="result"]';
const surface = 'dd[data-key="surface"]';

setTimeout(() => (console.log('gave up after 4 minutes'), process.exit(2)), 240_000);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && console.log('  console error:', m.text()));
  page.on('worker', (w) => w.on('console', (m) => m.text().includes('VanShade') && console.log('  worker:', m.text())));
  const t0 = Date.now();
  await page.goto(`${base}#${new URLSearchParams({ a: address, m: 'moment', d: '2026-06-21', t: '15:00' })}`);
  await page.locator(RESULT).waitFor({ timeout: 90_000 });
  const first = Date.now() - t0;
  await page.locator(surface, { hasText: /from/ }).waitFor({ timeout: 90_000, state: 'attached' });
  await page.locator(RESULT).waitFor();
  console.log(`first result ${first} ms, refined ${Date.now() - t0} ms: "${await page.locator(surface).textContent()}"`);
  console.log('  LiDAR from:', await page.locator('dd[data-key="lidar"]').textContent());
  console.log('  choices:', (await page.locator('#elevation-choice option').allTextContents()).join(' | '));
  await page.waitForTimeout(1200);
  await page.locator('.view-stage').screenshot({ path: join(OUT_DIR, `modes-${key}-best.png`) });
  if (await page.locator('#changes-wrap').isVisible()) {
    await page.locator('#changes-toggle').check();
    await page.waitForTimeout(800);
    await page.locator('.view-stage').screenshot({ path: join(OUT_DIR, `modes-${key}-changes-3d.png`) });
    await page.locator('input[name="view"][value="map"]').check();
    await page.waitForTimeout(500);
    await page.locator('.view-stage').screenshot({ path: join(OUT_DIR, `modes-${key}-changes-map.png`) });
    await page.locator('input[name="view"][value="3d"]').check();
    console.log('  legend:', await page.locator('#legend').innerText());
    await page.locator('#changes-toggle').uncheck();
  } else console.log('  (no change overlay offered)');
  for (const [mode, text] of [['newest', /1 m grid from/], ['detailed', /0\.5 m grid from the/], ['best', /with 20\d\d where|nothing near the lot/]] as const) {
    if (!(await page.locator(`#elevation-choice option[value="${mode}"]`).count())) continue;
    const s0 = Date.now();
    await page.locator('#elevation-choice').selectOption(mode);
    await page.locator(surface, { hasText: text }).waitFor({ timeout: 60_000, state: 'attached' });
    await page.locator(RESULT).waitFor();
    console.log(`${mode}: ${Date.now() - s0} ms: "${await page.locator(surface).textContent()}"; URL ${new URL(page.url()).hash.match(/elev=\w+/)?.[0] ?? '(default)'}`);
    await page.waitForTimeout(1000);
    await page.locator('.view-stage').screenshot({ path: join(OUT_DIR, `modes-${key}-${mode}.png`) });
  }
  const debug = await page.locator('#debug-facts').innerText();
  console.log(debug.split('\n').filter((l, i, a) => /Elevation source|Refinement|Surfaces|Cells/.test(a[i - 1] ?? '') || /Elevation source|Refinement|Surfaces|Cells/.test(l)).join('\n  '));
} finally {
  await browser.close();
  process.exit(0);
}
