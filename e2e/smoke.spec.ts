import { expect, type Page, test } from '@playwright/test';

const USER = 'demo';
const PASS = 'demo-password-123';

/**
 * Signs in, or performs first-run setup when the users file is empty. This
 * makes the flow re-runnable even if Playwright restarts the worker after a
 * failure and the server state is back at its initial condition.
 */
async function ensureSignedIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(PASS);
  const create = page.getByRole('button', { name: /create owner and sign in/i });
  if (await create.isVisible()) {
    await page.getByLabel('Confirm password').fill(PASS);
    await create.click();
  } else {
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expect(page.getByRole('heading', { name: /welcome back, demo/i })).toBeVisible();
}

test('first-run setup lands on the dashboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();

  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(PASS);
  await page.getByLabel('Confirm password').fill(PASS);
  await page.getByRole('button', { name: /create owner and sign in/i }).click();

  await expect(page.getByRole('heading', { name: /welcome back, demo/i })).toBeVisible();

  // Regression guard: the dashboard used to crash once the portfolio and the
  // lazy activity chart finished loading (React error #130 from a CJS-only
  // dependency being mis-bundled in production). Let both settle, then assert
  // the error boundary never took over.
  await expect(page.getByRole('heading', { name: 'Holdings' })).toBeVisible();
  await page.waitForTimeout(3000);
  await expect(page.getByText('Something broke in the interface')).toHaveCount(0);
});

test('previewing an allowlisted transfer shows T1 and sends nothing', async ({ page }) => {
  await ensureSignedIn(page);

  await page.getByRole('link', { name: 'Transfer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Transfer' })).toBeVisible();

  await page.getByLabel('Amount').fill('0.0001');
  await page.getByRole('button', { name: /check tier/i }).click();

  // First allowlist label (alice) is preselected; 0.0001 is within the auto cap.
  await expect(page.locator('.verdict')).toContainText('T1');
  // Only "Check tier" was clicked; nothing may have been signed or sent.
  const audit = await page.request.get('/api/audit/export');
  expect(await audit.text()).not.toContain('tx_sent');
});

test('security page shows the policy fingerprint and the guard rails', async ({ page }) => {
  await ensureSignedIn(page);

  await page.getByRole('link', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('heading', { name: /policy fingerprint/i })).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Policy fingerprint' }).locator('.mono')).toHaveText(/^[0-9a-f]{16}$/);
  await expect(page.getByRole('heading', { name: /on-chain guard/i })).toBeVisible();
});
