import { expect, test } from '@playwright/test';

const RESULT = '.scene-canvas[data-state="result"]';

test('search → 3D sun results → inspector → shareable link', async ({ page, context }) => {
  await page.goto('./');
  await expect(page.locator('#intro')).toBeVisible();

  await page.locator('#address-input').fill('453 W 12th Ave, Vancouver');
  await page.locator('#address-input').press('Enter');
  await expect(page.locator(RESULT)).toBeVisible();

  // Results, legend, caveats and attribution.
  await expect(page.locator('#lot-heading')).toHaveText('453 W 12th Ave, Vancouver, BC');
  await expect(page.locator('#lot-facts')).toContainText('City of Vancouver');
  // Full sun / part sun / shade is the default view.
  await expect(page.locator('#legend')).toContainText('Full sun (6+ h)');
  // A first visit explains how to read the view, once.
  await expect(page.locator('#tips')).toBeVisible();
  await page.locator('#tips-close').click();
  await expect(page.locator('#tips')).toBeHidden();

  // The result in plain words, first thing in the panel.
  await expect(page.locator('#result-headline')).toContainText(/hours of direct sun a day/);
  await expect(page.locator('#caveats')).toContainText('Lot lines are approximate');
  await expect(page.locator('.site-footer')).toContainText('Open Government Licence – Canada');

  // The first result is the 1 m HRDEM surface; a sharper one then swaps in: the 2016 point cloud
  // at 0.5 m, or, where the build has the LidarBC proxy, "best of both" with 2025 LidarBC.
  const surface = page.locator('dd[data-key="surface"]');
  await expect(surface).toContainText(/0\.5 m grid from the 2016 LiDAR point cloud|0\.5 m from 2016 LiDAR/, { timeout: 90_000 });
  await expect(page.locator(RESULT)).toBeVisible();
  // With both surveys, the "Elevation data" choice switches surfaces without reloading the page.
  if (await page.locator('#elevation-wrap').isVisible()) {
    await page.locator('#elevation-wrap > summary').click(); // under "More options"
    await page.locator('#elevation-choice').selectOption('newest');
    await expect(surface).toContainText('1 m grid from 2025', { timeout: 60_000 });
    await expect.poll(() => page.url()).toMatch(/elev=newest/);
    await page.locator('#elevation-choice').selectOption('best');
    await expect(surface).toContainText('0.5 m from 2016 LiDAR', { timeout: 60_000 });
    await expect(page.locator(RESULT)).toBeVisible();
  }

  // The aerial photo is on by default, with its credit line; turning it off goes into the link.
  await expect(page.locator('#photo-toggle')).toBeChecked();
  await expect(page.locator('#photo-credit')).toContainText('City of Vancouver');
  await expect(page.locator('#opacity-wrap')).toBeVisible();
  await page.locator('#photo-toggle').uncheck();
  await expect(page.locator('#photo-credit')).toBeHidden();
  await expect.poll(() => page.url()).toMatch(/img=0/);
  await page.locator('#photo-toggle').check();
  await expect(page.locator('#photo-credit')).toContainText('City of Vancouver');

  // Keyboard inspector: 12 monthly bars.
  await page.locator('.scene-canvas').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector svg.chart g.bar')).toHaveCount(12);

  // The URL carries the address and the mode; a fresh page restores both.
  await page.locator('input[name="mode"][value="day"]').check();
  await expect.poll(() => page.url()).toMatch(/a=453\+W\+12th\+Ave.*m=day/);
  const shared = await context.newPage();
  await shared.goto(page.url());
  await expect(shared.locator(RESULT)).toBeVisible();
  await expect(shared.locator('#lot-heading')).toHaveText('453 W 12th Ave, Vancouver, BC');
  await expect(shared.locator('input[name="mode"][value="day"]')).toBeChecked();
  await expect(shared.locator('#tips')).toBeHidden(); // already dismissed in this browser

  // About accuracy opens and closes.
  await shared.locator('#caveats [data-open-about]').click();
  await expect(shared.locator('#about')).toBeVisible();
  await shared.keyboard.press('Escape');
  await expect(shared.locator('#about')).toBeHidden();
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

test('mobile: the panel is a bottom sheet @mobile', async ({ page }) => {
  await page.goto('./');
  await page.locator('#address-input').fill('453 W 12th Ave, Vancouver');
  await page.locator('#address-input').press('Enter');
  await expect(page.locator(RESULT)).toBeVisible();
  // The collapsed sheet leads with the plain-language result.
  await expect(page.locator('#result-headline')).toBeInViewport();
  const handle = page.locator('#sheet-handle');
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#sun-controls')).not.toBeInViewport();
  await handle.click();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#sun-controls').scrollIntoViewIfNeeded();
  await expect(page.locator('#sun-controls')).toBeInViewport();
});
