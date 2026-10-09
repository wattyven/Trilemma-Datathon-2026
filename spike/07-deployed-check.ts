// Drives the real UI in headless Chromium against a local or deployed build.
//   node spike/07-deployed-check.ts http://localhost:5173/VanShade/
//   node spike/07-deployed-check.ts https://wattyven.github.io/VanShade/
// Closes the Phase 0 question: do geocoder and WFS CORS work from the github.io origin?
import { chromium, type Page } from 'playwright';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { OUT_DIR, writeOut } from './lib.ts';

const base = process.argv[2] ?? 'http://localhost:5173/VanShade/';
const tag = new URL(base).hostname.replace(/\W+/g, '-');
mkdirSync(OUT_DIR, { recursive: true });

interface Case {
  name: string;
  query: string;
  via: 'autocomplete' | 'submit';
  expect: { jurisdiction?: string; notice?: string; message?: RegExp };
  screenshot?: boolean;
  /** Must reach sun results within the 10 s budget. */
  timed?: boolean;
}

const cases: Case[] = [
  { name: 'Vancouver via autocomplete + keyboard', query: '453 W 12', via: 'autocomplete', expect: { jurisdiction: 'City of Vancouver' }, screenshot: true, timed: true },
  { name: 'City of North Vancouver', query: '141 W 14th St, North Vancouver', via: 'submit', expect: { jurisdiction: 'City of North Vancouver' } },
  { name: 'District of North Vancouver', query: '355 W Queens Rd, North Vancouver', via: 'submit', expect: { jurisdiction: 'District of North Vancouver' }, screenshot: true, timed: true },
  { name: 'Maple Ridge (2023 LiDAR)', query: '11995 Haney Pl, Maple Ridge', via: 'submit', expect: { jurisdiction: 'City of Maple Ridge' }, timed: true },
  { name: 'City of Langley', query: '20399 Douglas Cres, Langley', via: 'submit', expect: { jurisdiction: 'City of Langley' } },
  { name: 'Township of Langley', query: '20338 65 Ave, Langley', via: 'submit', expect: { jurisdiction: 'Township of Langley' } },
  { name: 'BLOCK match → nearest lot', query: '3000 Guildford Way, Coquitlam', via: 'submit', expect: { jurisdiction: 'City of Coquitlam', notice: 'nearest-lot' }, screenshot: true },
  { name: 'Strata (industrial units)', query: '3871 North Fraser Way, Burnaby', via: 'submit', expect: { notice: 'strata' } },
  { name: 'Out of area', query: '1 Centennial Sq, Victoria', via: 'submit', expect: { message: /Metro Vancouver only/ } },
  { name: 'Street only', query: 'W 12th Ave, Vancouver', via: 'submit', expect: { message: /not that house number/ } },
];

/** Done when sun results are drawn, or a message is showing (errors and out-of-area). */
async function settle(page: Page) {
  await page.waitForFunction(
    () => {
      const state = document.querySelector('#lot-canvas')?.getAttribute('data-state');
      const msg = !(document.querySelector('#message') as HTMLElement).hidden;
      const lotShown = !(document.querySelector('#lot') as HTMLElement).hidden;
      const scene = document.querySelector('.scene-canvas')?.getAttribute('data-state');
      const sceneReady = !document.querySelector('.scene-canvas') || scene === 'result';
      return (state === 'result' && sceneReady) || (msg && (!lotShown || state !== 'elevation'));
    },
    null,
    { timeout: 60_000 },
  );
}

// SwiftShader keeps WebGL working the same way in headless runs on any machine.
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const consoleErrors: string[] = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
const failedRequests: string[] = [];
page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url().slice(0, 140)}`));

const results: Record<string, unknown>[] = [];
let failures = 0;
try {
  await page.goto(`${base}#debug=1`, { waitUntil: 'networkidle' }); // debug=1 shows the debug details
  const build = await page.locator('meta[name="vanshade-build"]').getAttribute('content');
  console.log(`Page ${base} build=${build}`);

  for (const c of cases) {
    const t0 = Date.now();
    const input = page.locator('#address-input');
    await input.fill('');
    if (c.via === 'autocomplete') {
      await input.pressSequentially(c.query, { delay: 40 });
      await page.locator('[role="option"]').first().waitFor({ timeout: 15_000 });
      const first = await page.locator('[role="option"]').first().textContent();
      console.log(`  suggestions start with: ${first}`);
      await input.press('ArrowDown');
      await input.press('Enter');
    } else {
      await input.fill(c.query);
      await input.press('Enter');
    }
    await settle(page);
    const ms = Date.now() - t0;
    const state = await page.locator('#lot-canvas').getAttribute('data-state');
    const lotShown = await page.locator('#lot').isVisible();
    const facts = lotShown ? await page.locator('#lot-facts').innerText() : '';
    const notices = lotShown ? await page.locator('#lot-notices li').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.notice)) : [];
    const message = (await page.locator('#message').isVisible()) ? await page.locator('#message').innerText() : '';
    const heading = lotShown ? await page.locator('#lot-heading').innerText() : '';
    const summary = lotShown ? await page.locator('#result-summary').innerText() : '';
    const debug = lotShown ? await page.locator('#debug-facts').evaluate((el) => el.textContent ?? '') : '';

    const problems: string[] = [];
    if (c.expect.jurisdiction && !facts.includes(c.expect.jurisdiction)) problems.push(`jurisdiction ≠ ${c.expect.jurisdiction}`);
    if (c.expect.jurisdiction && c.expect.jurisdiction.startsWith('City of North') && facts.includes('District of North')) problems.push('CNV shown as DNV');
    if (c.expect.notice && !notices.includes(c.expect.notice)) problems.push(`missing notice ${c.expect.notice}`);
    if (c.expect.message && !c.expect.message.test(message)) problems.push(`message ≠ ${c.expect.message}`);
    if (c.expect.jurisdiction && state !== 'result') problems.push(`no sun results (state=${state}, message=${message})`);
    if (c.timed && ms > 10_000) problems.push(`took ${ms} ms > 10 s`);
    if (problems.length) failures++;
    results.push({ name: c.name, ok: !problems.length, problems, ms, heading, facts: facts.replace(/\s+/g, ' '), notices, message, summary, debug });
    console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${c.name} (${ms} ms) ${heading} | ${facts.replace(/\s+/g, ' ')} | ${notices.join(',')}${message ? ' | ' + message : ''}${problems.length ? '  ✗ ' + problems.join('; ') : ''}`);
    if (summary) console.log(`      ${summary}`);
    if (debug) console.log(`      ${debug.replace(/(Grid|Cells|Window|LiDAR|Timings)/g, ' | $1').trim()}`);
    if (c.screenshot) await page.screenshot({ path: join(OUT_DIR, `screen-${tag}-${c.name.replace(/\W+/g, '-').toLowerCase()}.png`), fullPage: true });

    // After the first lot: Phase 3 interactions on the 3D view.
    if (c === cases[0] && state === 'result') {
      const summary = () => page.locator('#result-summary').innerText();
      const before = await summary();
      // Dec 21 at solar noon as a Moment: the 3D shadows and the engine should both point true north.
      await page.locator('input[name="mode"][value="moment"]').check();
      await page.locator('#tl-date').fill('2026-12-21');
      await page.locator('#tl-date').dispatchEvent('change');
      await page.locator('#tl-time').evaluate((el: HTMLInputElement) => {
        el.value = String(12 * 60 + 10);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForFunction((b) => {
        const t = document.querySelector('#result-summary')?.textContent ?? '';
        return t !== b && !/Recalculating/.test(t);
      }, before, { timeout: 30_000 });
      console.log(`      Moment Dec 21 12:10 → ${await summary()} (slider label ${await page.locator('#tl-time-label').innerText()})`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT_DIR, `screen-${tag}-3d-moment-dec21-noon.png`), fullPage: true });
      // Summer late afternoon: shadows fall to the east, visible from the home view.
      await page.locator('#tl-date').fill('2026-06-21');
      await page.locator('#tl-date').dispatchEvent('change');
      await page.locator('#tl-time').evaluate((el: HTMLInputElement) => {
        el.value = String(17 * 60);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForFunction(() => /in the west/.test(document.querySelector('#result-summary')?.textContent ?? ''), null, { timeout: 30_000 });
      await page.waitForTimeout(500);
      await page.locator('.view-stage').screenshot({ path: join(OUT_DIR, `screen-${tag}-3d-jun21-1700.png`) });
      // Debug compare: engine shade over the 3D shadows.
      await page.locator('details.debug summary').click();
      await page.locator('#compare-toggle').check();
      await page.waitForTimeout(600);
      await page.locator('.view-stage').screenshot({ path: join(OUT_DIR, `screen-${tag}-3d-compare.png`) });
      await page.locator('#compare-toggle').uncheck();
      // Keyboard inspector: focus the 3D view, Enter → inspector with 12 bars and a strip.
      await page.locator('.scene-canvas').focus();
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');
      await page.locator('#inspector:not([hidden]) svg.chart').waitFor({ timeout: 20_000 });
      const bars = await page.locator('#inspector svg.chart g.bar').count();
      const strip = await page.locator('#inspector svg.strip rect').count();
      const inspectorOk = bars === 12 && strip > 0;
      if (!inspectorOk) failures++;
      console.log(`${inspectorOk ? 'PASS' : 'FAIL'}  keyboard inspector: ${bars} bars, ${strip} strip runs — ${(await page.locator('#inspector h3').innerText())}`);
      await page.locator('input[name="mode"][value="season"]').check();
      await page.waitForFunction(() => /sample days/.test(document.querySelector('#result-summary')?.textContent ?? ''), null, { timeout: 30_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT_DIR, `screen-${tag}-3d-season-inspector.png`), fullPage: true });
      // Map view toggle.
      await page.locator('input[name="view"][value="map"]').check({ force: true });
      const mapVisible = await page.locator('#lot-canvas').isVisible();
      if (!mapVisible) failures++;
      console.log(`${mapVisible ? 'PASS' : 'FAIL'}  map view toggle`);
      await page.locator('input[name="view"][value="3d"]').check({ force: true });
    }
  }
} finally {
  await browser.close();
}

writeOut(`deployed-check-${tag}.json`, { base, results, consoleErrors, failedRequests });
console.log(`\nConsole errors: ${consoleErrors.length ? '\n  ' + consoleErrors.join('\n  ') : 'none'}`);
console.log(`Failed requests: ${failedRequests.length ? '\n  ' + failedRequests.join('\n  ') : 'none'}`);
console.log(`${results.length - failures}/${results.length} cases passed`);
process.exit(failures || consoleErrors.some((e) => /CORS/i.test(e)) ? 1 : 0);
