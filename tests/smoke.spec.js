/**
 * smoke.spec.js — basic page load and UI element checks
 *
 * Verifies the app loads correctly and all expected controls are present
 * before running heavier session tests.
 */

const { test, expect } = require('@playwright/test');

test.describe('Page load', () => {
  test('loads without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    expect(errors, `JS errors on load: ${errors.join('; ')}`).toHaveLength(0);
  });

  test('shows session code input', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#codeInput')).toBeVisible();
  });

  test('shows Join Session button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#joinChannelBtn')).toBeVisible();
  });

  test('main app is hidden before joining', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#mainApp')).toBeHidden();
  });

  test('Start Scan is hidden before joining', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#startScanBtn')).toBeHidden();
  });
});
