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
  await expect(summary).toContainText(/Average hours of direct sun a day, 1 April to 30 September/);
  await expect(summary).toContainText(/Maximum:\s*([\d.]+) hours, in the/);
  await expect(summary).toContainText(/Minimum:\s*([\d.]+) hours, (in|near) the/);
  await expect(page.locator('#basic-from')).toHaveValue(/^\d{4}-04-01$/);
  await expect(page.locator('#sun-controls')).toBeHidden(); // modes, Measure at, 3D data: Advanced only
  await expect(page.locator('#timeline')).toBeHidden();
  await expect(page.locator('#legend')).toContainText('Hours of direct sun a day');
  await expect(page.locator('#caveats')).toContainText('Lot lines are approximate');
  await expect(page.locator('.site-footer')).toContainText('Open Government Licence – Canada');

  // Pins mark the sunniest and shadiest square metre; the summary's direction highlights one.
  const max = page.locator('.spot-pin[data-kind="sunniest"]');
  await expect(max).toBeVisible();
  await expect(max).toContainText(/^Max ([\d.]+|0) h/);
  await expect(page.locator('.spot-pin[data-kind="shadiest"]')).toContainText(/^Min ([\d.]+|0) h/);
  await summary.locator('button').first().click();
  await expect(max).toHaveClass(/flash/);
  // A pin opens its spot's months.
  await max.click();
  await expect(page.locator('#inspector svg.chart g.bar')).toHaveCount(12);

  // New dates recompute, and go into the link (no time, no Advanced settings).
  await page.locator('#basic-from').fill('2026-06-01');
  await page.locator('#basic-to').fill('2026-06-30');
  await page.locator('#basic-to').dispatchEvent('change');
  await expect(summary).toContainText('1 June to 30 June');
  await expect.poll(() => page.url()).toMatch(/cs=2026-06-01&ce=2026-06-30/);
  expect(page.url()).not.toMatch(/[#&](adv|t|m)=/);

  // The pins follow to the map; the aerial photo is on by default and its setting goes into the link.
  await page.locator('input[name="view"][value="map"]').check({ force: true });
  await expect(page.locator('.spot-pin:not([hidden])')).toHaveCount(2);
  await page.locator('input[name="view"][value="3d"]').check({ force: true });
  await expect(page.locator('#photo-toggle')).toBeChecked();
  await expect(page.locator('#photo-credit')).toContainText('City of Vancouver');
  await page.locator('#photo-toggle').uncheck();
  await expect.poll(() => page.url()).toMatch(/img=0/);
  await page.locator('#photo-toggle').check();

  // A fresh page restores the lot and the dates in Basic.
  const shared = await context.newPage();
  await shared.goto(page.url());
  await expect(shared.locator(RESULT)).toBeVisible();
  await expect(shared.locator('#basic-summary')).toContainText('1 June to 30 June');
  await expect(shared.locator('#tips')).toBeHidden(); // already dismissed in this browser
  // Links that use a setting only Advanced has (like older links with a mode) open in Advanced.
  const older = await context.newPage();
  await older.goto('./#a=453+W+12th+Ave%2C+Vancouver%2C+BC&m=day');
  await expect(older.locator(RESULT)).toBeVisible();
  await expect(older.locator('input[name="mode"][value="day"]')).toBeChecked();
  await expect(older.locator('#advanced-toggle')).toHaveAttribute('aria-checked', 'true');
  await older.close();

  // About accuracy opens and closes.
  await shared.locator('#caveats [data-open-about]').click();
  await expect(shared.locator('#about')).toBeVisible();
  await shared.keyboard.press('Escape');
  await expect(shared.locator('#about')).toBeHidden();
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
  await expect(frame.locator('#basic-summary')).toContainText('1 June to 30 June');
  await expect(frame.locator('#basic-summary')).toContainText(/Maximum:\s*([\d.]+) hours/);
  await expect(frame.locator('#basic-dates')).toBeHidden(); // the embedding page fixed the dates
  // The compact layout: no site header (kept for screen readers only), search or tips; a link back
  // to the full site.
  expect(await frame.locator('.site-header').evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
  await expect(frame.locator('#search-form')).toBeHidden();
  await expect(frame.locator('#tips')).toBeHidden();
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
