import { test, expect } from '@playwright/test';

test('landing page renders the marketing hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Roll the die/i })).toBeVisible();
  await expect(page.getByText(/Open the table/i).first()).toBeVisible();
});

test('protected route redirects unauthed user to sign-in', async ({ page }) => {
  await page.goto('/hub');
  // Clerk redirects to /sign-in
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});
