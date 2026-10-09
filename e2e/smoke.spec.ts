import { expect, test } from '@playwright/test';

const RESULT = '.scene-canvas[data-state="result"]';

test('Basic: search → maximum and minimum hours → pins → dates → shareable link', async ({ page, context }) => {
  await page.goto('./');
  await expect(page.locator('#intro')).toBeVisible();

  await page.locator('#address-input').fill('453 W 12th Ave, Vancouver');
  await page.locator('#address-input').press('Enter');
  await expect(page.locator(RESULT)).toBeVisible();
  await expect(page.locator('#lot-heading')).toHaveText('453 W 12th Ave, Vancouver, BC');
  // A first visit explains how to read the view, once.
  await expect(page.locator('#tips')).toBeVisible();
  await page.locator('#tips-close').click();
  await expect(page.locator('#tips')).toBeHidden();

  // Basic is the default: the lot's maximum and minimum average daily hours, and one setting, the dates.
  await expect(page.locator('html')).toHaveClass(/\bbasic\b/);
  const summary = page.locator('#basic-summary');
  await expect(page.locator('#basic-period')).toHaveText(/Average hours of direct sun a day, 1 April to 30 September/);
  await expect(summary).toContainText(/Maximum:\s*([\d.]+) hours, in the/);
  await expect(summary).toContainText(/Minimum:\s*([\d.]+) hours, (in|near) the/);
  // Typical weather as an extra line; its source and the other fine print in the "About these numbers" pop-up.
  await expect(summary).toContainText(/about ([\d.]+) hours with typical weather/);
  const numbers = page.locator('#numbers-info');
  await expect(numbers).toBeHidden();
  await page.locator('#numbers-open').click();
  await expect(numbers).toBeVisible();
  await expect(numbers).toContainText('Typical weather: sunshine records at Vancouver airport');
  await expect(numbers).toContainText('about 2 m × 2 m');
  await page.keyboard.press('Escape');
  await expect(numbers).toBeHidden();
  // In Basic the 3D / Map switch and the legend sit inside the map, and the map fits the window.
  await expect(page.locator('.view-stage .view-toolbar')).toBeVisible();
  await expect(page.locator('.view-stage #legend')).toBeVisible();
  await expect(page.locator('#basic-from')).toHaveValue(/^\d{4}-04-01$/);
  await expect(page.locator('#sun-controls')).toBeHidden(); // modes, Measure at, 3D data: Advanced only
  await expect(page.locator('#timeline')).toBeHidden();
  await expect(page.locator('#legend')).toContainText('Hours of direct sun a day');
  await expect(page.locator('#lot-notices')).toContainText('approximate, not a legal survey');
  await expect(page.locator('#lot-caveats')).toContainText('Trees count as solid all year');
  await expect(page.locator('.site-footer')).toContainText('Open Government Licence – Canada');

  // Pins mark the sunniest and shadiest square metre; the summary's direction highlights one.
  const max = page.locator('.spot-pin[data-kind="sunniest"]');
  await expect(max).toBeVisible();
  await expect(max).toContainText(/^Max ([\d.]+|0) h/);
  await expect(page.locator('.spot-pin[data-kind="shadiest"]')).toContainText(/^Min ([\d.]+|0) h/);
  await summary.locator('button').first().click();
  await expect(max).toHaveClass(/flash/);
  // A spot's months are Advanced only: in Basic the pins are markers, and the lot doesn't pick a spot.
  await expect(page.locator('#readout')).not.toContainText('Click a spot');
  await expect(max).toHaveAttribute('aria-hidden', 'true');
  await max.click({ force: true }); // lands on the view underneath
  await page.locator('.scene-canvas').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await expect(page.locator('#inspector')).toBeHidden();

  // Analysis: Gemini reads the lot through the proxy (stubbed here, so the test costs nothing). A
  // build without VITE_GEMINI_PROXY has no Analysis button; the deployed site must have one.
  const analysisOpen = page.locator('#analysis-open');
  if (process.env.BASE_URL || (await analysisOpen.isVisible())) {
    const asked: { context: string; turns: { role: string; text: string }[] }[] = [];
    await page.route(/\/chat$/, (route) => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      asked.push(route.request().postDataJSON());
      return route.fulfill({ headers: { ...cors, 'Content-Type': 'text/event-stream' }, body: 'data: {"text":"The south-east corner "}\n\ndata: {"text":"is sunniest."}\n\ndata: {"done":true}\n\n' });
    });
    await analysisOpen.click();
    const answers = page.locator('.analysis-msg[data-role="assistant"]');
    await expect(answers).toHaveText(['The south-east corner is sunniest.']);
    expect(asked[0]!.context).toContain('Address: 453 W 12th Ave, Vancouver, BC');
    expect(asked[0]!.context).toContain('with typical weather');
    // A suggested question goes with the conversation so far.
    await page.locator('#analysis-chips button').first().click();
    await expect(page.locator('.analysis-msg[data-role="user"]')).toHaveText(['Where should I plant vegetables?']);
    await expect(answers).toHaveCount(2);
    expect(asked[1]!.turns.map((t) => t.role)).toEqual(['user', 'model', 'user']);
    await page.keyboard.press('Escape');
    await expect(page.locator('#analysis-dialog')).toBeHidden();
    await page.unroute(/\/chat$/);
  }

  // New dates recompute, and go into the link (no time, no Advanced settings).
  await page.locator('#basic-from').fill('2026-06-01');
  await page.locator('#basic-to').fill('2026-06-30');
  await page.locator('#basic-to').dispatchEvent('change');
  await expect(page.locator('#basic-period')).toContainText('1 June to 30 June');
  await expect.poll(() => page.url()).toMatch(/cs=2026-06-01&ce=2026-06-30/);
  expect(page.url()).not.toMatch(/[#&](adv|t|m)=/);

  // The pins follow to the map. The aerial photo is always on, with no setting and nothing in the link.
  await page.locator('input[name="view"][value="map"]').check({ force: true });
  await expect(page.locator('.spot-pin:not([hidden])')).toHaveCount(2);
  await page.locator('input[name="view"][value="3d"]').check({ force: true });
  await expect(page.locator('#photo-toggle')).toHaveCount(0);
  await expect(page.locator('#photo-credit-item')).toContainText('City of Vancouver');
  expect(page.url()).not.toMatch(/[#&]img=/);

  // A fresh page restores the lot and the dates in Basic.
  const shared = await context.newPage();
  await shared.goto(page.url());
  await expect(shared.locator(RESULT)).toBeVisible();
  await expect(shared.locator('#basic-period')).toContainText('1 June to 30 June');
  await expect(shared.locator('#tips')).toBeHidden(); // already dismissed in this browser
  // Links that use a setting only Advanced has (like older links with a mode) open in Advanced.
  const older = await context.newPage();
  await older.goto('./#a=453+W+12th+Ave%2C+Vancouver%2C+BC&m=day');
  await expect(older.locator(RESULT)).toBeVisible();
  await expect(older.locator('input[name="mode"][value="day"]')).toBeChecked();
  await expect(older.locator('#advanced-toggle')).toHaveAttribute('aria-checked', 'true');
  await older.close();

  // About accuracy opens and closes.
  await shared.locator('#lot-caveats [data-open-about]').click();
  await expect(shared.locator('#about')).toBeVisible();
  await shared.keyboard.press('Escape');
  await expect(shared.locator('#about')).toBeHidden();

  // With a lot showing, the address bar sits in the header row beside the name, still usable.
  await expect(page.locator('html')).toHaveClass(/\bhas-lot\b/);
  const bar = (await page.locator('#address-input').boundingBox())!, name = (await page.locator('#home-link').boundingBox())!;
  expect(Math.abs(bar.y + bar.height / 2 - (name.y + name.height / 2))).toBeLessThan(20);
  await expect(page.locator('#address-input')).toBeEditable();
  // The title goes back to the start page; Back returns to the lot.
  await page.locator('#home-link').click();
  await expect(page.locator('#intro')).toBeVisible();
  await expect(page.locator('#lot')).toBeHidden();
  await expect(page.locator('html')).not.toHaveClass(/\bhas-lot\b/);
  expect(new URL(page.url()).hash).toBe('');
  await page.goBack();
  await expect(page.locator(RESULT)).toBeVisible();
});

test('Advanced: modes, time, 3D data, inspector and links', async ({ page, context }) => {
  await page.goto('./#adv=1');
  await page.locator('#address-input').fill('453 W 12th Ave, Vancouver');
  await page.locator('#address-input').press('Enter');
  await expect(page.locator(RESULT)).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/\bbasic\b/);
  await expect(page.locator('#lot-facts')).toContainText('City of Vancouver');
  await page.locator('#tips-close').click();

  // "One moment" (now, or midday after dark) is Advanced's default view, and the link says so.
  await expect(page.locator('input[name="mode"][value="moment"]')).toBeChecked();
  await expect(page.locator('#legend')).toContainText('In direct sun');
  await expect.poll(() => page.url()).toMatch(/m=moment.*adv=1/);
  await expect(page.locator('#result-headline')).toContainText(/is in direct sun/);
  // No pins at a single moment: each spot is just in sun or in shade.
  await expect(page.locator('.spot-pin:not([hidden])')).toHaveCount(0);
  // Season shows full / part sun / shade, with pins on the sunniest and shadiest spots.
  await page.locator('input[name="mode"][value="season"]').check();
  await expect(page.locator('#legend')).toContainText('Full sun (6+ h)');
  await expect(page.locator('#result-headline')).toContainText(/hours of direct sun a day/);
  await expect(page.locator('#result-headline')).toContainText(/With typical weather, expect about/);
  await expect(page.locator('#result-summary')).toContainText(/with typical weather/);
  await expect(page.locator('.spot-pin[data-kind="sunniest"]')).toContainText(/^Max ([\d.]+|0) h/);
  await expect(page.locator('.spot-pin[data-kind="shadiest"]')).toBeVisible();
  // The timeline shows the day's sunrise and sunset, and Now returns to the current time.
  await expect(page.locator('#tl-sun')).toContainText(/Sunrise \d{1,2}:\d\d am · Sunset \d{1,2}:\d\d pm/);
  const sunrise = await page.locator('#tl-time').getAttribute('min');
  await page.locator('#tl-time').evaluate((el: HTMLInputElement, v) => {
    el.value = v!;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, sunrise);
  const atSunrise = await page.locator('#tl-time-label').textContent();
  await page.locator('#tl-now').click();
  await expect(page.locator('#tl-time-label')).not.toHaveText(atSunrise!);
  // Debug details only with debug=1.
  await expect(page.locator('#debug')).toBeHidden();
  await expect(page.locator('#opacity-wrap')).toBeVisible();

  // The first result is the 1 m HRDEM surface; a sharper one then swaps in: the 2016 point cloud
  // at 0.5 m, or, where the build has the LidarBC proxy, "best of both" with 2025 LidarBC.
  const surface = page.locator('dd[data-key="surface"]');
  await expect(surface).toContainText(/0\.5 m grid from the 2016 LiDAR point cloud|0\.5 m from 2016 LiDAR/, { timeout: 90_000 });
  await expect(page.locator(RESULT)).toBeVisible();
  // With both surveys, the "3D data" choice switches surfaces without reloading the page.
  if (await page.locator('#elevation-wrap').isVisible()) {
    await page.locator('#elevation-wrap > summary').click(); // under "More options"
    await page.locator('#elevation-choice').selectOption('newest');
    await expect(surface).toContainText('1 m grid from 2025', { timeout: 60_000 });
    await expect.poll(() => page.url()).toMatch(/elev=newest/);
    await page.locator('#elevation-choice').selectOption('best');
    await expect(surface).toContainText('0.5 m from 2016 LiDAR', { timeout: 60_000 });
    await expect(page.locator(RESULT)).toBeVisible();
  }

  // Keyboard inspector: 12 monthly bars.
  await page.locator('.scene-canvas').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector svg.chart g.bar')).toHaveCount(12);
  // The pins setting turns them off (and goes into the link).
  await page.locator('input[name="spots"]').uncheck();
  await expect(page.locator('.spot-pin:not([hidden])')).toHaveCount(0);
  await expect.poll(() => page.url()).toMatch(/spots=0/);
  await page.locator('input[name="spots"]').check();

  // The URL carries the mode; a fresh page restores it in Advanced.
  await page.locator('input[name="mode"][value="day"]').check();
  await expect.poll(() => page.url()).toMatch(/a=453\+W\+12th\+Ave.*m=day/);
  const shared = await context.newPage();
  await shared.goto(page.url());
  await expect(shared.locator(RESULT)).toBeVisible();
  await expect(shared.locator('input[name="mode"][value="day"]')).toBeChecked();
  await shared.close();

  // Back to Basic: the summary returns, and the link drops Advanced.
  await page.locator('#advanced-toggle').click(); // the "Advanced mode" switch
  await expect(page.locator('html')).toHaveClass(/\bbasic\b/);
  await expect(page.locator('#basic-summary')).toContainText(/Maximum:\s*([\d.]+) hours/);
  await expect(page.locator('#inspector')).toBeHidden(); // the spot picked in Advanced
  await expect.poll(() => page.url()).not.toMatch(/adv=1/);
});

test('embed: "Copy embed code" gives an iframe that works on another page', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./#a=453+W+12th+Ave%2C+Vancouver%2C+BC&p=custom&cs=2026-06-01&ce=2026-06-30');
  await expect(page.locator(RESULT)).toBeVisible();
  await page.locator('#share-embed').click();
  await expect(page.locator('#share-status')).toContainText('Embed code copied');
  const code = await page.evaluate(() => navigator.clipboard.readText());
  expect(code).toMatch(/^<iframe src="[^"]+embed=1[^"]*"[^>]* title="VanShade: sun and shade at 453 W 12th Ave, Vancouver, BC"><\/iframe>$/);

  // A page on another site holding that iframe. Results load inside it, so the frame isn't
  // blocked and the parcel lookup works from it (it needs a Referer).
  const host = await context.newPage();
  await host.setContent(`<!doctype html><title>A gardening blog</title><body>${code}</body>`);
  const frame = host.frameLocator('iframe');
  await expect(frame.locator(RESULT)).toBeVisible();
  await expect(frame.locator('#lot-heading')).toHaveText('453 W 12th Ave, Vancouver, BC');
  await expect(frame.locator('#basic-period')).toContainText('1 June to 30 June');
  await expect(frame.locator('#basic-summary')).toContainText(/Maximum:\s*([\d.]+) hours/);
  await expect(frame.locator('#basic-dates')).toBeHidden(); // the embedding page fixed the dates
  // The compact layout: no site header (kept for screen readers only), search or tips; a link back
  // to the full site.
  expect(await frame.locator('.site-header .brand').evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
  await expect(frame.locator('#search-form')).toBeHidden();
  await expect(frame.locator('#tips')).toBeHidden();
  await expect(frame.locator('#analysis-open')).toBeHidden(); // no chat on other sites' pages
  await expect(frame.locator('#embed-bar')).toContainText('Open Government Licences');
  const open = frame.locator('#embed-open');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('href', /#a=453\+W\+12th\+Ave.*cs=2026-06-01/);
  await expect(open).not.toHaveAttribute('href', /embed=/);
  await host.close();
});

test('"Use my location" finds the nearest address', async ({ browser }) => {
  const here = await browser.newContext({ geolocation: { latitude: 49.26131, longitude: -123.11394 }, permissions: ['geolocation'] }); // Vancouver City Hall
  const page = await here.newPage();
  await page.goto('./');
  await page.locator('#locate').click();
  await expect(page.locator('#lot-heading')).toContainText('Vancouver, BC');
  await expect(page.locator(RESULT)).toBeVisible();
  await here.close();

  const denied = await browser.newContext(); // no permission granted
  const page2 = await denied.newPage();
  await page2.goto('./');
  await page2.locator('#locate').click();
  await expect(page2.locator('#message')).toContainText('Location is turned off');
  await denied.close();
});

test('out-of-area addresses get a clear message', async ({ page }) => {
  await page.goto('./');
  await page.locator('#address-input').fill('1 Centennial Sq, Victoria');
  await page.locator('#address-input').press('Enter');
  await expect(page.locator('#message')).toContainText('Metro Vancouver only');
});

test('mobile: Basic stacks the summary over the view; Advanced uses a bottom sheet @mobile', async ({ page }) => {
  await page.goto('./');
  await page.locator('#address-input').fill('453 W 12th Ave, Vancouver');
  await page.locator('#address-input').press('Enter');
  await expect(page.locator(RESULT)).toBeVisible();
  await expect(page.locator('#basic-summary')).toBeInViewport();
  await expect(page.locator('#sheet-handle')).toBeHidden();

  await page.locator('#advanced-toggle').click(); // the "Advanced mode" switch
  // The collapsed sheet leads with the plain-language result.
  const handle = page.locator('#sheet-handle');
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#result-headline')).toBeInViewport();
  await expect(page.locator('#sun-controls')).not.toBeInViewport();
  await handle.click();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#sun-controls').scrollIntoViewIfNeeded();
  await expect(page.locator('#sun-controls')).toBeInViewport();
});
