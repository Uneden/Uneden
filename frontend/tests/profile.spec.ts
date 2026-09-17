import { test, expect } from '@playwright/test';

// Seller account id: seeded value locally (supabase/seed.sql), production id otherwise.
const USER_ID = process.env.TEST_USER_ID || '975a5680-cf13-4500-b2db-795b0b5cbe1a';

test.describe('Profile page', () => {
  test('own profile loads without error', async ({ page }) => {
    await page.goto(`/profile/${USER_ID}`);
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/login/);
  });

  test('displays user name or company name', async ({ page }) => {
    await page.goto(`/profile/${USER_ID}`);
    await page.waitForLoadState('networkidle');
    // Profile header should show a name
    const name = page.locator('h1, h2').first();
    await expect(name).toBeVisible({ timeout: 15000 });
    const text = await name.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test('shows listings section on profile', async ({ page }) => {
    await page.goto(`/profile/${USER_ID}`);
    await page.waitForLoadState('networkidle');
    // Wait for listings spinner to resolve
    await page.waitForTimeout(3000);
    const hasListings = await page.locator('a[href*="/serviceDetail/"]').count() > 0;
    // Match the actual empty-state texts rendered by the component
    const hasEmpty = await page.locator('h2, h3, p').filter({ hasText: /no listings|listings yet|hasn't posted/i }).isVisible().catch(() => false);
    expect(hasListings || hasEmpty).toBe(true);
  });

  test('settings button is visible on own profile', async ({ page }) => {
    await page.goto(`/profile/${USER_ID}`);
    await page.waitForLoadState('networkidle');
    // Profile owner sees Settings button (editing is done inside the Settings modal)
    const settingsBtn = page.locator('button').filter({ hasText: /settings|paramètres/i }).first();
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
  });
});
