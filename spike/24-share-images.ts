// The link-preview card (public/og-image.jpg, 1200 × 630) and the home-screen icon
// (public/apple-touch-icon.png, 180 × 180). The card shows a real result: Vancouver City Hall's lot
// over its aerial photo, in Season view, rendered by the app itself.
//   node spike/24-share-images.ts [base url]
import { chromium } from 'playwright';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SPIKE_DIR } from './lib.ts';

const base = process.argv[2] ?? 'http://localhost:5180/VanShade/';
const ROOT = join(SPIKE_DIR, '..');
const PUBLIC = join(ROOT, 'public');
const font = readFileSync(join(ROOT, 'src/assets/fonts/fraunces-600-latin.woff2')).toString('base64');
const T = { fog: '#F6F4EE', cedar: '#1E2B25', moss: '#5E7A5A', sun: '#E9A23B', mist: '#D8D5CB' }; // src/styles.css
const SUN_ICON = (size: number, colour: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}"><circle cx="16" cy="16" r="7" fill="${colour}"/><g stroke="${colour}" stroke-width="2.5" stroke-linecap="round"><path d="M16 2v4M16 26v4M2 16h4M26 16h4M6 6l3 3M23 23l3 3M6 26l3-3M23 9l3-3"/></g></svg>`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // 1. The lot, as the app draws it.
  const app = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await app.addInitScript(() => localStorage.setItem('vanshade:tips-seen-v1', '1'));
  const hash = new URLSearchParams({ a: '453 W 12th Ave, Vancouver, BC', m: 'season', d: '2026-06-21', t: '15:30', spots: '0' }); // a cleaner card without pins
  await app.goto(`${base}#${hash}`);
  await app.locator('dd[data-key="surface"]').filter({ hasText: /0\.5 m/ }).waitFor({ state: 'attached', timeout: 120_000 });
  await app.locator('.scene-canvas[data-state="result"]').waitFor({ timeout: 60_000 });
  await app.locator('#hud').evaluate((el) => (el.style.visibility = 'hidden'));
  // Zoom in a little: the default view leaves room for the neighbours.
  const box = (await app.locator('.scene-canvas').boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) await app.mouse.wheel(0, -120);
  await app.waitForTimeout(1500);
  const lot = (await app.locator('.view-stage').screenshot({ type: 'png' })).toString('base64');
  const legend = await app.locator('#legend .legend-item').evaluateAll((items) =>
    items.slice(0, 3).map((i) => ({ colour: (i.querySelector('.swatch') as HTMLElement).style.background, text: i.textContent ?? '' })),
  );
  await app.close();

  // 2. The card.
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await card.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: Fraunces; font-weight: 600; src: url(data:font/woff2;base64,${font}) format('woff2'); }
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; display: grid; grid-template-columns: 500px 700px; background: ${T.fog}; color: ${T.cedar};
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    .text { padding: 64px 40px 56px 64px; display: flex; flex-direction: column; }
    .mark { display: flex; align-items: center; gap: 16px; }
    h1 { font: 600 76px/1 Fraunces, Georgia, serif; letter-spacing: -0.01em; }
    p.tag { margin-top: 28px; font-size: 34px; line-height: 1.25; font-weight: 500; }
    ul { list-style: none; padding: 0; margin-top: auto; display: grid; gap: 12px; font-size: 24px; }
    li { display: flex; align-items: center; gap: 12px; }
    .sw { width: 26px; height: 26px; border-radius: 5px; border: 1px solid rgba(0,0,0,0.15); }
    .where { margin-top: 28px; font-size: 22px; color: ${T.moss}; }
    .lot { background: url(data:image/png;base64,${lot}) center / cover no-repeat; border-left: 1px solid ${T.mist}; }
  </style></head><body>
    <div class="text">
      <div class="mark">${SUN_ICON(60, T.sun)}<h1>VanShade</h1></div>
      <p class="tag">Find the sunny and shady spots in your yard.</p>
      <ul>${legend.map((l) => `<li><span class="sw" style="background:${l.colour}"></span>${l.text}</li>`).join('')}</ul>
      <p class="where">Metro Vancouver · free, no account</p>
    </div>
    <div class="lot"></div>
  </body></html>`);
  await card.evaluate(() => document.fonts.ready);
  await card.screenshot({ path: join(PUBLIC, 'og-image.jpg'), type: 'jpeg', quality: 82 });
  await card.close();

  // 3. The home-screen icon: the favicon's sun on fog (iOS rounds the corners itself).
  const icon = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
  await icon.setContent(`<!doctype html><html><body style="margin:0;width:180px;height:180px;display:grid;place-items:center;background:${T.fog}">${SUN_ICON(132, T.sun)}</body></html>`);
  await icon.screenshot({ path: join(PUBLIC, 'apple-touch-icon.png'), type: 'png' });
  await icon.close();

  for (const f of ['og-image.jpg', 'apple-touch-icon.png']) console.log(`public/${f}: ${(statSync(join(PUBLIC, f)).size / 1024).toFixed(0)} KiB`);
  console.log('legend:', legend.map((l) => l.text).join(' | '));
} finally {
  await browser.close();
}
