import { test, expect } from '@playwright/test';

const HAS_CLERK_TESTING = !!process.env.CLERK_TESTING_TOKEN_USER_ID;

test('unauthed /campaigns redirects to sign-in', async ({ page }) => {
  await page.goto('/campaigns');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test('unauthed /campaigns/new redirects to sign-in', async ({ page }) => {
  await page.goto('/campaigns/new');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test('authenticated golden path: create → play → resume', async ({ page }) => {
  test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');

  await page.goto('/hub');
  await page.getByRole('link', { name: /new campaign/i }).first().click();
  await expect(page).toHaveURL(/\/campaigns\/new$/);

  // Step 1: pick the first available template character.
  // Characters are rendered as buttons whose subtitle includes "L<number>"
  await page.locator('button').filter({ hasText: /L\d+/ }).first().click();
  await page.getByRole('button', { name: /next: premise/i }).click();

  // Step 2: keep the default preset, submit.
  await page.getByRole('button', { name: /begin the tale/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);
  await expect(page.locator('text=Send').first()).toBeVisible({ timeout: 10_000 });

  // Resume from hub.
  await page.goto('/hub');
  await page.locator('a[href^="/campaigns/"]').first().click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+$/);
  await page.getByRole('link', { name: /continue/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);
});

test('301 redirects /sessions → /campaigns', async ({ page }) => {
  await page.goto('/sessions');
  // Next.js permanent redirects are followed transparently; assert final URL.
  await expect(page).toHaveURL(/\/(campaigns|sign-in)/);

  await page.goto('/sessions/new');
  await expect(page).toHaveURL(/\/(campaigns\/new|sign-in)/);
});

test('authenticated user can delete a campaign', async ({ page }) => {
  test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');

  // Create through the UI wizard so we don't depend on a test-only API.
  await page.goto('/campaigns/new');
  await page.locator('button').filter({ hasText: /L\d+/ }).first().click();
  await page.getByRole('button', { name: /next: premise/i }).click();

  // Edit the name so we can find this campaign later.
  // The label has no htmlFor, so match by placeholder instead.
  await page.locator('input[placeholder="auto-derived from preset"]').fill('To be deleted');

  // Accept the window.confirm dialog that DeleteCardButton uses.
  page.on('dialog', (dialog) => dialog.accept());

  await page.getByRole('button', { name: /begin the tale/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);

  // Find the campaign in the list.
  await page.goto('/campaigns');
  const card = page.locator('a[href^="/campaigns/"]').filter({ hasText: 'To be deleted' }).first();
  const detailHref = await card.getAttribute('href');
  expect(detailHref).toBeTruthy();
  await card.click();

  // Click delete — triggers window.confirm (accepted by the dialog handler above).
  await page.locator('button[aria-label="Delete"]').click();
  await page.waitForURL(/\/(campaigns|hub)$/);

  // Visiting the old detail URL must 404.
  const after = await page.goto(detailHref!);
  expect(after?.status()).toBe(404);
});
