import { test, expect } from '@playwright/test';

// The listing form requires an address picked from Google Places suggestions,
// which needs a Maps API key and live autocomplete. These tests therefore stop
// at "form filled, validation enforced" instead of submitting a real listing.

test.describe('Post listing complete flow', () => {
  test('offer form accepts title and description but stays gated until complete', async ({ page }) => {
    await page.goto('/post');

    const offerBtn = page.locator('button[type="button"]').filter({ hasText: /offer|offr/i }).first();
    await offerBtn.click();
    await expect(offerBtn).toHaveClass(/bg-green-700/);

    const title = page.getByPlaceholder(/Nettoyage professionnel|Professional House Cleaning/i);
    await title.fill('Test listing Playwright');
    await expect(title).toHaveValue('Test listing Playwright');

    const desc = page.locator('#desc-main');
    await desc.fill('This is an automated test listing created by Playwright. Please ignore.');
    await expect(desc).toHaveValue(/Playwright/);

    // Category / price / location are still missing → the form must not submit
    const submitBtn = page.locator('button[type="submit"]').first();
    await expect(submitBtn).toBeVisible();
    await submitBtn.click({ force: true });
    await expect(page).toHaveURL(/\/post/);
    await expect(page.locator('text=/succès|success|publié|published/i')).toHaveCount(0);
  });

  test('looking form switches labels and accepts a job title', async ({ page }) => {
    await page.goto('/post');

    const lookingBtn = page.locator('button[type="button"]').filter({ hasText: /looking|cherche/i }).first();
    await lookingBtn.click();
    await expect(lookingBtn).toHaveClass(/bg-green-700/);

    // Placeholders change with the mode
    const title = page.getByPlaceholder(/Besoin d'aide|Need help/i);
    await title.fill('Looking for plumber - Playwright test');
    await expect(title).toHaveValue(/plumber/);

    const desc = page.locator('#desc-main');
    await desc.fill('Need a plumber for a quick repair.');
    await expect(desc).toHaveValue(/plumber/);

    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
  });
});
