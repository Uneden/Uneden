import { test, expect } from '@playwright/test';

async function skipIfPostingUnavailable(page: import('@playwright/test').Page) {
  const canadaOnlyGate = page.locator('text=/Available in Canada only|Disponible au Canada/i').first();
  if (await canadaOnlyGate.isVisible().catch(() => false)) {
    test.skip(true, 'Posting is gated for the current test account because the profile is not eligible to post in Canada.');
  }
}

test.describe('Post a listing', () => {
  test('loads post page without redirecting to login', async ({ page }) => {
    await page.goto('/post');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/login/);
  });

  test('shows both mode buttons: Offer and Looking', async ({ page }) => {
    await page.goto('/post');
    await page.waitForLoadState('networkidle');
    await skipIfPostingUnavailable(page);
    // Two toggle buttons for offer / looking modes
    const buttons = page.locator('button[type="button"]').filter({ hasText: /offer|offr|looking|cherche/i });
    await expect(buttons.first()).toBeVisible({ timeout: 10000 });
  });

  test('can switch between offer and looking modes', async ({ page }) => {
    await page.goto('/post');
    await page.waitForLoadState('networkidle');
    await skipIfPostingUnavailable(page);
    const lookingBtn = page.locator('button[type="button"]').filter({ hasText: /looking|cherche/i }).first();
    await lookingBtn.click();
    await expect(lookingBtn).toHaveClass(/bg-green-700/);

    const offerBtn = page.locator('button[type="button"]').filter({ hasText: /offer|offr/i }).first();
    await offerBtn.click();
    await expect(offerBtn).toHaveClass(/bg-green-700/);
  });

  test('form is visible with required fields', async ({ page }) => {
    await page.goto('/post');
    await page.waitForLoadState('networkidle');
    await skipIfPostingUnavailable(page);
    // Bilingual form: title input is identified by its placeholder, description by id
    await expect(page.getByPlaceholder(/Nettoyage professionnel|Professional House Cleaning/i)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#desc-main')).toBeVisible();
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
  });
});
