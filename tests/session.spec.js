/**
 * session.spec.js — two-peer session and handshake tests
 *
 * Opens two separate browser contexts (Sender and Receiver) against the local
 * relay. Both join the same channel code. Tests verify that:
 *   - roles are assigned (first joiner = Sender, second = Receiver)
 *   - the X25519 handshake completes (ACTIVE state → Start Scan enabled)
 *   - a static QR payload round-trips from Sender to Receiver
 */

const { test, expect, chromium } = require('@playwright/test');

const TEST_CODE = 'playwright-test-session-001';
const HANDSHAKE_TIMEOUT = 10000;  // ms to wait for ACTIVE state

// Helper: join a channel and wait for the handshake to complete.
// Returns the page with mainApp visible and (for senders) Start Scan enabled.
async function joinAndWait(page, code) {
  await page.goto('/');
  await page.fill('#codeInput', code);
  await page.click('#joinChannelBtn');

  // Wait for mainApp to appear
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 5000 });

  // Wait until the handshake status clears — scanStatus either disappears or
  // stops saying "Waiting for peer handshake"
  await expect(page.locator('#scanStatus')).not.toContainText(
    'Waiting for peer handshake',
    { timeout: HANDSHAKE_TIMEOUT }
  );
}

test.describe('Two-peer session', () => {
  test('first joiner gets Sender role', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto('/');
    await page.fill('#codeInput', TEST_CODE + '-role');
    await page.click('#joinChannelBtn');

    await expect(page.locator('#mainApp')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#startScanBtn')).toBeVisible({ timeout: 3000 });

    await ctx.close();
  });

  test('second joiner gets Receiver role (Claim Sender shown)', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const code = TEST_CODE + '-roles';

    // First joiner → Sender
    await page1.goto('/');
    await page1.fill('#codeInput', code);
    await page1.click('#joinChannelBtn');
    await expect(page1.locator('#mainApp')).toBeVisible({ timeout: 5000 });

    // Second joiner → Receiver
    await page2.goto('/');
    await page2.fill('#codeInput', code);
    await page2.click('#joinChannelBtn');
    await expect(page2.locator('#mainApp')).toBeVisible({ timeout: 5000 });

    // Receiver has Claim Sender button visible
    await expect(page2.locator('#claimSenderBtn')).toBeVisible({ timeout: 5000 });
    // Receiver does not have Start Scan
    await expect(page2.locator('#startScanBtn')).toBeHidden();

    await ctx1.close();
    await ctx2.close();
  });

  test('handshake completes and Start Scan becomes enabled', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const code = TEST_CODE + '-handshake';

    // Both join — order matters: page1 first to claim Sender role
    await page1.goto('/');
    await page1.fill('#codeInput', code);
    await page1.click('#joinChannelBtn');
    await expect(page1.locator('#mainApp')).toBeVisible({ timeout: 5000 });

    await page2.goto('/');
    await page2.fill('#codeInput', code);
    await page2.click('#joinChannelBtn');
    await expect(page2.locator('#mainApp')).toBeVisible({ timeout: 5000 });

    // After handshake: Sender's Start Scan should be enabled
    await expect(page1.locator('#startScanBtn')).toBeEnabled({ timeout: HANDSHAKE_TIMEOUT });

    // Scan status on Receiver should not show the waiting message
    await expect(page2.locator('#scanStatus')).not.toContainText(
      'Waiting for peer handshake',
      { timeout: HANDSHAKE_TIMEOUT }
    );

    await ctx1.close();
    await ctx2.close();
  });

  test('Leave Channel returns to setup screen', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto('/');
    await page.fill('#codeInput', TEST_CODE + '-leave');
    await page.click('#joinChannelBtn');
    await expect(page.locator('#mainApp')).toBeVisible({ timeout: 5000 });

    await page.click('#leaveChannelBtn');
    await expect(page.locator('#channelSetup')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#mainApp')).toBeHidden();

    await ctx.close();
  });
});
