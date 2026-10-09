// Side-by-side: the first (HRDEM 1 m) result and the refined (point cloud 0.5 m) result for a few
// lots, with the debug panel's source line and timings.  node spike/14-hires-compare.ts [base url]
import { chromium, type Page } from 'playwright';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { OUT_DIR } from './lib.ts';

const base = process.argv[2] ?? 'http://localhost:5180/';
mkdirSync(OUT_DIR, { recursive: true });
const RESULT = '.scene-canvas[data-state="result"]';
const ALL_LOTS = [
  ['kits', '2425 MacDonald St, Vancouver'],
  ['surrey', '13450 104 Ave, Surrey'],
  ['mapleridge', '11995 Haney Pl, Maple Ridge'],
];
const LOTS = process.env.LOTS ? ALL_LOTS.filter(([k]) => process.env.LOTS!.split(',').includes(k!)) : ALL_LOTS;
// Sources to compare, e.g. ELEV=hrdem,copc,auto (auto = what the app picks).
const SOURCES = (process.env.ELEV ?? 'hrdem,auto').split(',');

const debugRows = (page: Page) =>
  page.locator('#debug-facts').evaluate((dl) => {
    const out: Record<string, string> = {};
    const dts = dl.querySelectorAll('dt');
    dts.forEach((dt) => (out[dt.textContent ?? ''] = (dt.nextElementSibling as HTMLElement | null)?.textContent ?? ''));
    return out;
  });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (const [key, address] of LOTS) {
    for (const elev of SOURCES) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      page.on('console', (m) => m.text().includes('VanShade') && console.log('  console:', m.text()));
      page.on('worker', (w) => w.on('console', (m) => m.text().includes('VanShade') && console.log('  worker console:', m.text(), JSON.stringify(m.location()))));
      const hash = new URLSearchParams({ a: address!, d: '2026-06-21', t: '17:00', m: 'moment', debug: '1' });
      if (elev !== 'auto') hash.set('elev', elev);
      const t0 = Date.now();
      await page.goto(`${base}#${hash}`);
      await page.locator(RESULT).waitFor({ timeout: 90_000 });
      const first = Date.now() - t0;
      let refined = 0;
      if (elev !== 'hrdem') {
        await page.locator('dd[data-key="surface"]', { hasText: /from/ }).waitFor({ timeout: 90_000, state: 'attached' }).catch(() => {});
        await page.locator(RESULT).waitFor();
        refined = Date.now() - t0;
      }
      await page.waitForTimeout(1500);
      await page.locator('#scene-host').screenshot({ path: join(OUT_DIR, `hires-${key}-${elev}.png`) });
      const rows = await debugRows(page);
      const surface = await page.locator('dd[data-key="surface"]').textContent();
      console.log(`${key} ${elev}: first ${first} ms${refined ? `, refined ${refined} ms` : ''}; surface "${surface}"`);
      console.log(`  ${rows['Elevation source']}\n  ${rows['Refinement']}\n  ${rows['Cells']}\n  ${rows['Timings']}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
