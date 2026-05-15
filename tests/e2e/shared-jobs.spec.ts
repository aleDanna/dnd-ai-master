import { test, expect } from '@playwright/test';

const HAS_CLERK_TESTING = !!process.env.CLERK_TESTING_TOKEN_USER_ID;

test('unauthed /sessions still redirects to sign-in (smoke)', async ({ page }) => {
  await page.goto('/sessions/00000000-0000-0000-0000-000000000000');
  await page.waitForURL(/\/(sign-in|campaigns)/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/(sign-in|campaigns)/);
});

test('authenticated game-client renders Listen button on master messages', async ({ page }) => {
  test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');

  await page.goto('/campaigns/new');
  await page.locator('button').filter({ hasText: /L\d+/ }).first().click();
  await page.getByRole('button', { name: /next: premise/i }).click();
  await page.getByRole('button', { name: /begin the tale/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);

  // Master's initial narration should arrive within a few seconds.
  await expect(page.getByRole('button', { name: /listen/i }).first()).toBeVisible({ timeout: 30_000 });
});
