import { test, expect } from '@playwright/test';

const HAS_CLERK_TESTING = !!process.env.CLERK_TESTING_TOKEN_USER_ID;

// This test exercises the unauthed paths only. Full sign-in + game flow requires
// a Clerk testing token (https://clerk.com/docs/testing/playwright/overview);
// configure CLERK_TESTING_TOKEN_USER_ID in .env.local to enable richer tests.

test('sessions list redirects to sign-in for unauthed user', async ({ page }) => {
  await page.goto('/sessions');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test('new-session page redirects to sign-in for unauthed user', async ({ page }) => {
  await page.goto('/sessions/new');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test('authenticated user sees the sessions list', async ({ page }) => {
  test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');
  await page.goto('/sessions');
  await expect(page.getByRole('heading', { name: /Sessions/i })).toBeVisible();
});
