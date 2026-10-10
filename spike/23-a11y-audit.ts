// Accessibility check: axe-core (WCAG 2.0–2.2 A/AA + best practice) on the welcome, the intro, the
// guided start and a result, desktop and phone, and on the embedded layout (embed=1); the keyboard
// order from the top; phone tap targets under 24 px; and horizontal scrolling at 200% zoom. axe is loaded from cdnjs into
// the test browser only.
//   node spike/23-a11y-audit.ts [base url]
import { chromium, devices, type Page } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5180/';
const AXE = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
const RESULT = '.scene-canvas[data-state="result"]';
const LOT = '#a=453+W+12th+Ave%2C+Vancouver%2C+BC';
let failures = 0;

async function audit(page: Page, label: string) {
  await page.addScriptTag({ url: AXE });
  const r = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
  console.log(`${r.violations.length ? '✗' : '✓'} axe, ${label}: ${r.violations.length} rule(s) violated`);
  for (const v of r.violations) {
    failures++;
    console.log(`  [${v.impact}] ${v.id}: ${v.help}`);
    for (const n of v.nodes.slice(0, 3)) console.log(`    ${n.target.join(' ')}`);
  }
}

/** Buttons, fields and links on screen smaller than 24 px (sliders and links in a sentence aside). */
async function smallTargets(page: Page, label: string) {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button, input, select, a, summary')]
      .filter((e) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        const exempt = (e as HTMLInputElement).type === 'range' || e.closest('p, li, dd')?.tagName === 'P' && e.tagName === 'A'; // sliders and links in a sentence
        return r.width > 0 && r.height > 0 && !exempt && (r.width < 24 || r.height < 24);
      })
      .map((e) => `${e.tagName.toLowerCase()}${(e as HTMLElement).id ? '#' + (e as HTMLElement).id : ''}${(e as HTMLInputElement).type && e.tagName === 'INPUT' ? `[${(e as HTMLInputElement).type}]` : ''} ${Math.round((e as HTMLElement).getBoundingClientRect().width)}×${Math.round((e as HTMLElement).getBoundingClientRect().height)}`),
  );
  console.log(`${small.length ? '✗' : '✓'} phone tap targets under 24 px, ${label}: ${small.length}${small.length ? ` (${small.slice(0, 10).join(', ')})` : ''}`);
  failures += small.length ? 1 : 0;
}

/** Basic's other views (afternoon shade, one day), each audited once it's computed. */
async function auditBasicViews(page: Page, device: string) {
  for (const [name, period] of [['Afternoon shade', 'How often'], ['One day', 'Hours of direct sun on']] as const) {
    await page.locator('#basic-views label', { hasText: name }).click();
    await page.locator('#basic-period', { hasText: period }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
    await audit(page, `result (Basic, ${name}), ${device}`);
    if (device === 'phone') await smallTargets(page, `Basic, ${name}`);
  }
}

/** Answer /chat locally, so nothing goes to Gemini (every lot's Analysis reads itself). */
async function stubChat(page: Page) {
  await page.route(/\/chat$/, (route) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ headers: { ...cors, 'Content-Type': 'text/event-stream' }, body: 'data: {"text":"The south-east corner is sunniest."}\n\ndata: {"done":true}\n\n' });
  });
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // A first visit: the welcome, then "just browsing" for the intro.
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await stubChat(desk);
  await desk.goto(base);
  await desk.locator('#welcome[open]').waitFor();
  await audit(desk, 'welcome, desktop');
  await desk.locator('#welcome button[value="browse"]').click();
  await desk.reload(); // a returning visitor, so the keyboard order starts from the top
  await audit(desk, 'intro, desktop');
  const order: string[] = [];
  for (let i = 0; i < 6; i++) {
    await desk.keyboard.press('Tab');
    order.push(await desk.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}` : 'none'; }));
  }
  console.log(`  keyboard order: ${order.join(' → ')}`);
  // The guided start: step 1, then step 3 with the advice open (chat stubbed).
  const guided = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await stubChat(guided);
  await guided.goto(base);
  await guided.locator('#welcome button[value="garden"]').click();
  await audit(guided, 'guide, step 1, desktop');
  await guided.locator('#address-input').fill('453 W 12th Ave, Vancouver');
  await guided.locator('#address-input').press('Enter');
  await guided.locator(RESULT).waitFor({ timeout: 90_000 });
  if ((await guided.locator('#guide-steps li').count()) === 3) {
    await guided.locator('#guide-steps li[aria-current="step"] button').waitFor({ timeout: 60_000 });
    await guided.locator('.analysis-msg[data-role="assistant"]').waitFor();
    await audit(guided, 'guide, step 3 with the advice, desktop');
  } else await audit(guided, 'guide, step 2, desktop');
  await guided.close();

  await desk.goto(base + LOT);
  await desk.locator(RESULT).waitFor({ timeout: 90_000 });
  await desk.waitForTimeout(2500);
  await audit(desk, 'result (Basic), desktop');
  // The Analysis chat with its reading (the proxy stubbed, so nothing goes to Gemini).
  if (await desk.locator('#analysis-dialog').isVisible()) {
    await desk.locator('.analysis-msg[data-role="assistant"]').waitFor({ timeout: 60_000 });
    await audit(desk, 'Analysis chat, desktop');
  } else console.log('- Analysis chat skipped: no VITE_GEMINI_PROXY in this build');
  await auditBasicViews(desk, 'desktop');
  const adv = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await stubChat(adv);
  await adv.goto(`${base}${LOT}&adv=1&m=season`);
  await adv.locator(RESULT).waitFor({ timeout: 90_000 });
  await adv.waitForTimeout(2500);
  await audit(adv, 'result (Advanced, Season), desktop');

  const mob = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await stubChat(mob);
  await mob.goto(base);
  await mob.locator('#welcome[open]').waitFor();
  await audit(mob, 'welcome, phone');
  await smallTargets(mob, 'welcome');
  await mob.locator('#welcome button[value="garden"]').click();
  await smallTargets(mob, 'guide, step 1');
  await mob.goto(base + LOT);
  await mob.locator(RESULT).waitFor({ timeout: 90_000 });
  await mob.waitForTimeout(2500);
  await audit(mob, 'result (Basic), phone');
  await auditBasicViews(mob, 'phone');
  // The map, with its zoom buttons and shadows (still in One day).
  await mob.locator('input[name="view"][value="map"]').check({ force: true });
  await mob.locator('#map-zoom-in').waitFor();
  await audit(mob, 'Map view, phone');
  await smallTargets(mob, 'Map view');
  await mob.locator('input[name="view"][value="3d"]').check({ force: true });
  await mob.locator('#advanced-toggle').click();
  await mob.waitForTimeout(800);
  await audit(mob, 'result (Advanced), phone');
  await mob.locator('#sheet-handle').click();
  await mob.waitForTimeout(400);
  await smallTargets(mob, 'result (Advanced)');

  // Embedded at a typical blog column size (an iframe 600 px tall).
  const embed = await browser.newPage({ viewport: { width: 700, height: 600 } });
  await embed.goto(`${base}${LOT}&embed=1`);
  await embed.locator(RESULT).waitFor({ timeout: 90_000 });
  await embed.waitForTimeout(2500);
  await audit(embed, 'embedded result, 700 × 600');
  const embedOverflow = await embed.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`${embedOverflow > 0 ? '✗' : '✓'} embedded: ${embedOverflow > 0 ? `${embedOverflow} px of horizontal scrolling` : 'no horizontal scrolling'}`);
  failures += embedOverflow > 0 ? 1 : 0;

  const zoom = await browser.newPage({ viewport: { width: 640, height: 800 } }); // 1280 px at 200%
  await stubChat(zoom);
  await zoom.goto(base + LOT);
  await zoom.locator(RESULT).waitFor({ timeout: 90_000 });
  const overflow = await zoom.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`${overflow > 0 ? '✗' : '✓'} 200% zoom: ${overflow > 0 ? `${overflow} px of horizontal scrolling` : 'no horizontal scrolling'}`);
  failures += overflow > 0 ? 1 : 0;
  const zoomGuide = await browser.newPage({ viewport: { width: 640, height: 800 } });
  await zoomGuide.goto(base);
  await zoomGuide.locator('#welcome[open]').waitFor();
  const welcomeOverflow = await zoomGuide.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await zoomGuide.locator('#welcome button[value="home"]').click();
  const guideOverflow = await zoomGuide.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const most = Math.max(welcomeOverflow, guideOverflow);
  console.log(`${most > 0 ? '✗' : '✓'} 200% zoom, welcome and guide: ${most > 0 ? `${most} px of horizontal scrolling` : 'no horizontal scrolling'}`);
  failures += most > 0 ? 1 : 0;
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
