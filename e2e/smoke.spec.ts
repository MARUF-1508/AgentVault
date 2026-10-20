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

  await page.getByLabel('Amount', { exact: true }).fill('0.0001');
  await page.getByRole('button', { name: /check tier/i }).click();

  // First allowlist label (alice) is preselected; 0.0001 is within the auto cap.
  await expect(page.locator('.verdict')).toContainText('T1');
  // Only "Check tier" was clicked; nothing may have been signed or sent.
  const audit = await page.request.get('/api/audit/export');
  expect(await audit.text()).not.toContain('tx_sent');
});

test('an agent hand-off keeps the transfer form in the main column', async ({ page }) => {
  await ensureSignedIn(page);

  // Regression guard: the review banner used to be a direct grid child, so the
  // form was pushed into the narrow sidebar column and the page looked empty.
  await page.goto('/transfer?to=0x1111111111111111111111111111111111111111&amount=0.0001');
  const note = page.locator('.notice', { hasText: /from the Agent page/i });
  await expect(note).toBeVisible();
  await expect(page.locator('.grid-side .notice')).toHaveCount(0);

  const card = page.locator('.card', { hasText: 'Check and send' });
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box, 'the transfer card is visible').not.toBeNull();
  expect(box!.x, 'the transfer card sits in the main column').toBeLessThan(500);
  const limits = page.locator('.card', { hasText: "Today's limits" });
  expect((await limits.boundingBox())!.x, "the limits card sits in the sidebar column").toBeGreaterThan(box!.x + 300);
});

test('recipient lists give the label its own column and never overlap the button', async ({ page }) => {
  await ensureSignedIn(page);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  // Settings is lazy-loaded: wait for the page itself before looking for the card.
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const heading = page.getByRole('heading', { name: 'Recipients', exact: true });
  await expect(heading).toBeVisible();
  const card = page.locator('.card', { has: heading });
  // Reduced motion is on for the whole suite: off-screen Reveal content must
  // already be at full opacity instead of waiting for a scroll event.
  await expect(page.locator('[data-reveal]', { has: heading })).toHaveCSS('opacity', '1');
  await card.scrollIntoViewIfNeeded();

  // Regression guard: the labels used to fall into the 28px avatar column of
  // the shared .team grid and wrapped into a one-letter-per-line sliver.
  const row = card.locator('.policy-list li').first();
  const name = await row.locator('.team-name').boundingBox();
  const button = await row.getByRole('button', { name: /remove/i }).boundingBox();
  expect(name, 'the first allowlist row renders a label').not.toBeNull();
  expect(name!.width).toBeGreaterThanOrEqual(60);
  expect(button).not.toBeNull();
  const overlaps = name!.x < button!.x + button!.width && button!.x < name!.x + name!.width;
  expect(overlaps, 'label and Remove button occupy disjoint columns').toBe(false);

  const scrollW = await page.evaluate(() => document.scrollingElement!.scrollWidth);
  const innerW = await page.evaluate(() => window.innerWidth);
  expect(scrollW).toBeLessThanOrEqual(innerW + 1);

  // Regression guard: at phone width the shared label column starved the
  // address into a ~4-character sliver. It must get a full-width own row.
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  const addr = await row.locator('.addr').boundingBox();
  expect(addr, 'the first allowlist row renders an address').not.toBeNull();
  expect(addr!.width).toBeGreaterThanOrEqual(180);
  const deniedRows = card.locator('.policy-list.denied li .addr');
  if (await deniedRows.count()) {
    const deniedAddr = await deniedRows.first().boundingBox();
    expect(deniedAddr, 'the denylist row renders an address').not.toBeNull();
    expect(deniedAddr!.width).toBeGreaterThanOrEqual(180);
  }

  // Regression guard: the two side-by-side inputs in "Add a known recipient"
  // used to force the whole card (and the page) to 475px at a 390px viewport.
  const mobileScrollW = await page.evaluate(() => document.scrollingElement!.scrollWidth);
  expect(mobileScrollW, 'Settings does not scroll horizontally at phone width').toBeLessThanOrEqual(391);
  await page.getByRole('heading', { name: 'Add a known recipient' }).scrollIntoViewIfNeeded();
  await expect(card.getByLabel('Label')).toBeVisible();
  await expect(card.getByLabel('Address', { exact: true })).toBeVisible();
});

test('the agent page fits a phone viewport', async ({ page }) => {
  await ensureSignedIn(page);

  await page.getByRole('link', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agent' })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator('.chat')).toBeVisible();

  // Regression guard: a plain 1fr track took its min-content width from the
  // chat card, so both cards overflowed a 360px screen by 19px.
  const scrollW = await page.evaluate(() => document.scrollingElement!.scrollWidth);
  expect(scrollW, 'the Agent page does not scroll horizontally at phone width').toBeLessThanOrEqual(361);
});

test('the receive dialog closes with Escape', async ({ page }) => {
  await ensureSignedIn(page);

  await page.getByRole('button', { name: /receive/i }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Receive funds' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('security page shows the policy fingerprint and the guard rails', async ({ page }) => {
  await ensureSignedIn(page);

  await page.getByRole('link', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('heading', { name: /policy fingerprint/i })).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Policy fingerprint' }).locator('.mono')).toHaveText(/^[0-9a-f]{16}$/);
  await expect(page.getByRole('heading', { name: /on-chain guard/i })).toBeVisible();
});

test('an owner can pause and resume from the UI, with the password', async ({ page }) => {
  await ensureSignedIn(page);

  await page.getByRole('button', { name: /pause wallet/i }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText(/kill switch is on/i)).toBeVisible();

  await page.getByRole('button', { name: /resume signing/i }).click();
  const dialog = page.getByRole('dialog', { name: /resume the wallet/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Your password').fill(PASS);
  await dialog.getByRole('button', { name: /resume and allow signing/i }).click();
  await expect(page.getByText(/kill switch is on/i)).toBeHidden();
});
