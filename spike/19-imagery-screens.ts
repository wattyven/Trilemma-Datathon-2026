// Screenshots of the aerial photo in the 3D view and on the map for a few municipalities (tile,
// export and image-server sources) and one gap.  node spike/19-imagery-screens.ts [base url]
import { chromium } from 'playwright';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { OUT_DIR } from './lib.ts';

const base = process.argv[2] ?? 'http://localhost:5180/';
mkdirSync(OUT_DIR, { recursive: true });
const RESULT = '.scene-canvas[data-state="result"]';
const ALL = [
  ['vancouver', '2425 MacDonald St, Vancouver'],
  ['dnv', '355 W Queens Rd, North Vancouver'],
  ['surrey', '13450 104 Ave, Surrey'],
  ['coquitlam', '3000 Guildford Way, Coquitlam'],
  ['mapleridge', '11995 Haney Pl, Maple Ridge'],
  ['richmond-gap', '6911 No. 3 Rd, Richmond'],
];
const LOTS = process.env.LOTS ? ALL.filter(([k]) => process.env.LOTS!.split(',').includes(k!)) : ALL;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (const [key, address] of LOTS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', (m) => m.type() === 'error' && console.log('  console error:', m.text()));
    const hash = new URLSearchParams({ a: address!, img: '1', op: '0.6', m: 'moment', d: '2026-06-21', t: '15:00', elev: 'hrdem' });
    const t0 = Date.now();
    await page.goto(`${base}#${hash}`);
    await page.locator(RESULT).waitFor({ timeout: 90_000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('photo-credit');
      return el && !el.hidden && !/Loading/.test(el.textContent ?? '');
    }, undefined, { timeout: 60_000 }).catch(() => {});
    const ms = Date.now() - t0;
    await page.waitForTimeout(1200);
    const credit = await page.locator('#photo-credit').textContent();
    await page.locator('.view-stage').screenshot({ path: join(OUT_DIR, `photo-${key}-3d.png`) });
    await page.locator('input[name="view"][value="map"]').check();
    await page.waitForTimeout(400);
    await page.locator('.view-stage').screenshot({ path: join(OUT_DIR, `photo-${key}-map.png`) });
    const debug = await page.locator('#debug-facts').innerText();
    console.log(`${key}: ${ms} ms; "${credit}"; ${/Aerial photo\s+(.*)/.exec(debug)?.[1]}`);
    await page.close();
  }
} finally {
  await browser.close();
}
