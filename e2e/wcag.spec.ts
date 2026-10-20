import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Automated WCAG 2.2 AA check (axe-core) of every page in both themes, plus the
 * keyboard contract axe cannot see: skip link, focus moving into dialogs and
 * back, Escape closing them. Runs after smoke.spec.ts (alphabetical, 1 worker),
 * which has already created the owner account.
 */
const USER = 'demo';
const PASS = 'demo-password-123';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PAGES = [
  { path: '/', heading: /welcome back/i },
  { path: '/agent', heading: 'Agent' },
  { path: '/transfer', heading: 'Transfer' },
  { path: '/automation', heading: 'Automation' },
  { path: '/activity', heading: 'Activity' },
  { path: '/security', heading: 'Security' },
  { path: '/settings', heading: 'Settings' },
];

// Animations off, so axe measures settled colours rather than a mid-fade frame.
test.use({ reducedMotion: 'reduce' });

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(PASS);
  const create = page.getByRole('button', { name: /create owner and sign in/i });
  if (await create.isVisible()) {
    await page.getByLabel('Confirm password').fill(PASS);
    await create.click();
  } else {
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
}

async function expectNoViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
  expect(summary, `${label} has WCAG violations`).toEqual([]);
}

test('the sign-in page meets WCAG 2.2 AA', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading').first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expectNoViolations(page, 'login');
});

for (const theme of ['light', 'dark'] as const) {
  test(`every page meets WCAG 2.2 AA in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('av-theme', t), theme);
    await signIn(page);
    for (const { path, heading } of PAGES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      // Let polled data (status, budget, health) render before scanning.
      await page.waitForTimeout(800);
      await expectNoViolations(page, `${path} (${theme})`);
    }
  });
}

test('keyboard: skip link, landmarks, and dialogs that trap focus and close on Escape', async ({ page }) => {
  await signIn(page);
  await page.goto('/transfer');
  await expect(page.getByRole('heading', { level: 1, name: 'Transfer' })).toBeVisible();

  // The first Tab stop is the skip link, and it lands on the main region.
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Command palette: opens with Ctrl+K, keeps focus inside, Escape closes it
  // and focus returns to where it was.
  const search = page.getByRole('button', { name: /search and commands/i });
  await search.focus();
  await page.keyboard.press('Enter');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  const searchBox = page.getByRole('combobox', { name: /search pages and actions/i });
  await expect(searchBox).toBeFocused();

  // Arrow keys keep focus in the field but expose the highlighted option to
  // assistive tech, and the list scrolls so the selection never disappears.
  const options = palette.getByRole('option');
  const count = await options.count();
  for (let i = 1; i < count; i++) await page.keyboard.press('ArrowDown');
  await expect(searchBox).toHaveAttribute('aria-activedescendant', `palette-opt-${count - 1}`);
  const listBox = await palette.getByRole('listbox').boundingBox();
  const lastOption = await options.last().boundingBox();
  expect(lastOption, 'the last option is scrolled into view').not.toBeNull();
  expect(lastOption!.y + lastOption!.height).toBeLessThanOrEqual(listBox!.y + listBox!.height + 1);

  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  expect(await palette.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(search).toBeFocused();

  // Account menu: Escape closes it and returns focus to its button.
  const account = page.getByRole('button', { name: /account menu/i });
  await account.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: /sign out/i })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: /sign out/i })).toBeHidden();
  await expect(account).toBeFocused();
});

test('status messages reach screen readers through a live region', async ({ page }) => {
  await signIn(page);
  await page.goto('/transfer');
  await page.getByLabel('Amount', { exact: true }).fill('0.0001');
  await page.getByRole('button', { name: /check tier/i }).click();
  await expect(page.locator('#av-live')).toContainText(/Policy verdict: T1/);
});
