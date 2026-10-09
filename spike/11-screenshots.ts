// Screenshots for the README (docs/screenshots/) and for reviewing Phase 4 states (spike/out/).
//   node spike/11-screenshots.ts [base url]
import { chromium, devices, type Page } from 'playwright';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { OUT_DIR, SPIKE_DIR } from './lib.ts';

const base = process.argv[2] ?? 'http://localhost:5180/VanShade/';
const DOCS = join(SPIKE_DIR, '..', 'docs', 'screenshots');
mkdirSync(DOCS, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
const RESULT = '.scene-canvas[data-state="result"]';
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

async function search(page: Page, q: string) {
  await page.locator('#address-input').fill(q);
  await page.locator('#address-input').press('Enter');
  await page.locator(RESULT).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(800);
}

/** Wait for the sharper surface to swap in, so screenshots show the final detail. */
async function refined(page: Page) {
  await page.locator('dd[data-key="surface"]').filter({ hasText: /0\.5 m/ }).waitFor({ state: 'attached', timeout: 120_000 });
  await page.locator(RESULT).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
}
const tipsSeen = () => localStorage.setItem('vanshade:tips-seen-v1', '1'); // README shots skip the first-visit card

const browser = await chromium.launch({ args });
try {
  // Desktop: empty state, then a lot in Season view with the inspector open, then About.
  const desk = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await desk.addInitScript(tipsSeen);
  await desk.goto(base);
  await desk.screenshot({ path: join(OUT_DIR, 'review-intro.png') });
  await search(desk, '453 W 12th Ave, Vancouver');
  await desk.locator('input[name="mode"][value="season"]').check(); // the default is One moment
  await refined(desk);
  await desk.locator('#tl-date').fill('2026-06-21');
  await desk.locator('#tl-date').dispatchEvent('change');
  await desk.locator('#tl-time').evaluate((el: HTMLInputElement) => {
    el.value = String(16 * 60);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await desk.locator('.scene-canvas').focus();
  for (const k of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'Enter']) await desk.keyboard.press(k);
  await desk.locator('#inspector svg.chart').waitFor();
  await desk.waitForTimeout(500);
  await desk.locator('.scene-canvas').blur();
  await desk.evaluate(() => window.scrollTo(0, 0)); // the inspector opens below the fold
  await desk.waitForTimeout(300);
  await desk.screenshot({ path: join(DOCS, 'desktop.png') });
  await desk.locator('#inspector').screenshot({ path: join(DOCS, 'inspector.png') });
  await desk.screenshot({ path: join(OUT_DIR, 'review-desktop-full.png'), fullPage: true });
  await desk.locator('#caveats [data-open-about]').click();
  await desk.waitForTimeout(300);
  await desk.screenshot({ path: join(OUT_DIR, 'review-about.png') });
  await desk.keyboard.press('Escape');

  // Classes with custom thresholds.
  await desk.locator('input[name="classes"]').check();
  await desk.locator('input[name="fullSunH"]').fill('8');
  await desk.locator('input[name="fullSunH"]').dispatchEvent('change');
  await desk.waitForTimeout(500);
  await desk.locator('.lot').screenshot({ path: join(OUT_DIR, 'review-classes.png') });
  console.log('URL after changes:', desk.url());

  // Offline: a retry message.
  await desk.context().setOffline(true);
  await desk.locator('#address-input').fill('4949 Canada Way, Burnaby');
  await desk.locator('#address-input').press('Enter');
  await desk.locator('#message').waitFor();
  await desk.locator('main').screenshot({ path: join(OUT_DIR, 'review-offline.png') });
  console.log('Offline message:', await desk.locator('#message').innerText());
  await desk.context().setOffline(false);

  // Mobile: collapsed and expanded sheet.
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const mob = await ctx.newPage();
  await mob.addInitScript(tipsSeen);
  await mob.goto(`${base}#${new URLSearchParams({ a: '355 W Queens Rd, District of North Vancouver, BC', m: 'moment', d: '2026-06-21', t: '15:30' })}`);
  await refined(mob);
  await mob.locator('.view-toolbar').evaluate((el) => el.scrollIntoView({ block: 'start' })); // the view, with the sheet below
  await mob.waitForTimeout(500);
  await mob.screenshot({ path: join(DOCS, 'mobile.png') });
  await mob.locator('#sheet-handle').click();
  await mob.waitForTimeout(300);
  await mob.screenshot({ path: join(OUT_DIR, 'review-mobile-expanded.png') });

  // Embedded (embed=1), the size an iframe in a blog column would be.
  const emb = await browser.newPage({ viewport: { width: 720, height: 600 }, deviceScaleFactor: 1 });
  await emb.goto(`${base}#${new URLSearchParams({ a: '453 W 12th Ave, Vancouver, BC', m: 'moment', d: '2026-06-21', t: '15:30', embed: '1' })}`);
  await refined(emb);
  await emb.screenshot({ path: join(DOCS, 'embed.png') });
} finally {
  await browser.close();
}
console.log('screenshots written');
