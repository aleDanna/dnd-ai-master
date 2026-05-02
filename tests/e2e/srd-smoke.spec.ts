import { test, expect } from '@playwright/test';

test('SRD smoke: landing lists spells, detail page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /SRD smoke test/i })).toBeVisible();

  const firstLink = page.locator('main ul li a').first();
  const href = await firstLink.getAttribute('href');
  expect(href).toMatch(/^\/srd\/spells\/[a-z0-9-]+$/);

  await firstLink.click();
  await expect(page.getByText(/Casting Time/i)).toBeVisible();
  await expect(page.getByText(/Description/i)).toBeVisible();
});
