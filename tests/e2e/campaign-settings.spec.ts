import { test, expect } from '@playwright/test';

const HAS_CLERK_TESTING = !!process.env.CLERK_TESTING_TOKEN_USER_ID;

test('unauthed /campaigns/<id>/settings redirects to sign-in', async ({ page }) => {
  await page.goto('/campaigns/00000000-0000-0000-0000-000000000000/settings');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test('authenticated host: settings link reachable from campaign detail', async ({ page }) => {
  test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');

  // Create a fresh campaign so we have a stable detail page to open.
  await page.goto('/campaigns/new');
  await page.locator('button').filter({ hasText: /L\d+/ }).first().click();
  await page.getByRole('button', { name: /next: premise/i }).click();
  await page.getByRole('button', { name: /begin the tale/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);

  // Jump to the campaign detail page via /hub → first campaign card.
  await page.goto('/hub');
  await page.locator('a[href^="/campaigns/"]').first().click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+$/);

  // The Settings button should be present and navigate to the settings page.
  const settingsLink = page.getByRole('link', { name: /settings/i }).first();
  await expect(settingsLink).toBeVisible();
  await settingsLink.click();
  await page.waitForURL(/\/campaigns\/[0-9a-f-]+\/settings$/);

  // Page renders: "Campaign settings" heading is the giveaway.
  await expect(page.getByRole('heading', { name: /campaign settings/i })).toBeVisible();
  // Host can edit: the read-only banner copy must NOT be present.
  await expect(page.getByText(/Solo il creatore della campagna/)).toHaveCount(0);
});
