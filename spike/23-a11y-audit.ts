// Accessibility check: axe-core (WCAG 2.0–2.2 A/AA + best practice) on the intro and a result,
// desktop and phone, and on the embedded layout (embed=1); the keyboard order from the top; phone
// tap targets under 24 px; and horizontal scrolling at 200% zoom. axe is loaded from cdnjs into
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

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desk.goto(base);
  await audit(desk, 'intro, desktop');
  const order: string[] = [];
  for (let i = 0; i < 6; i++) {
    await desk.keyboard.press('Tab');
    order.push(await desk.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}` : 'none'; }));
  }
  console.log(`  keyboard order: ${order.join(' → ')}`);
  await desk.goto(base + LOT);
  await desk.locator(RESULT).waitFor({ timeout: 90_000 });
  await desk.waitForTimeout(2500);
  await audit(desk, 'result (Basic), desktop');
  // The Analysis chat, open with an answer (the proxy stubbed, so nothing goes to Gemini).
  if (await desk.locator('#analysis-open').isVisible()) {
    await desk.route(/\/chat$/, (route) => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      return route.fulfill({ headers: { ...cors, 'Content-Type': 'text/event-stream' }, body: 'data: {"text":"The south-east corner is sunniest."}\n\ndata: {"done":true}\n\n' });
    });
    await desk.locator('#analysis-open').click();
    await desk.locator('.analysis-msg[data-role="assistant"]').waitFor();
    await audit(desk, 'Analysis chat, desktop');
  } else console.log('- Analysis chat skipped: no VITE_GEMINI_PROXY in this build');
  const adv = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await adv.goto(`${base}${LOT}&adv=1&m=season`);
  await adv.locator(RESULT).waitFor({ timeout: 90_000 });
  await adv.waitForTimeout(2500);
  await audit(adv, 'result (Advanced, Season), desktop');

  const mob = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await mob.goto(base + LOT);
  await mob.locator(RESULT).waitFor({ timeout: 90_000 });
  await mob.waitForTimeout(2500);
  await audit(mob, 'result (Basic), phone');
  await mob.locator('#advanced-toggle').click();
  await mob.waitForTimeout(800);
  await audit(mob, 'result (Advanced), phone');
  await mob.locator('#sheet-handle').click();
  await mob.waitForTimeout(400);
  const small = await mob.evaluate(() =>
    [...document.querySelectorAll('button, input, select, a, summary')]
      .filter((e) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        const exempt = (e as HTMLInputElement).type === 'range' || e.closest('p, li, dd')?.tagName === 'P' && e.tagName === 'A'; // sliders and links in a sentence
        return r.width > 0 && r.height > 0 && !exempt && (r.width < 24 || r.height < 24);
      })
      .map((e) => `${e.tagName.toLowerCase()}${(e as HTMLElement).id ? '#' + (e as HTMLElement).id : ''}${(e as HTMLInputElement).type && e.tagName === 'INPUT' ? `[${(e as HTMLInputElement).type}]` : ''} ${Math.round((e as HTMLElement).getBoundingClientRect().width)}×${Math.round((e as HTMLElement).getBoundingClientRect().height)}`),
  );
  console.log(`${small.length ? '✗' : '✓'} phone tap targets under 24 px: ${small.length}${small.length ? ` (${small.slice(0, 10).join(', ')})` : ''}`);
  failures += small.length ? 1 : 0;

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
  await zoom.goto(base + LOT);
  await zoom.locator(RESULT).waitFor({ timeout: 90_000 });
  const overflow = await zoom.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`${overflow > 0 ? '✗' : '✓'} 200% zoom: ${overflow > 0 ? `${overflow} px of horizontal scrolling` : 'no horizontal scrolling'}`);
  failures += overflow > 0 ? 1 : 0;
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
