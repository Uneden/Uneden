import { test, expect } from '@playwright/test';

// These tests run without saved auth (testing public pages)
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Register form validation', () => {
  test('shows register form starting with email', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).not.toBeVisible();
  });

  test('shows password fields after email step', async ({ page }) => {
    await page.goto('/register?email=test@example.com');
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#confirm_password')).toBeVisible();
  });

  test('shows name fields before password on second step', async ({ page }) => {
    await page.goto('/register?email=test@example.com');
    await expect(page.locator('#first_name')).toBeVisible();
    await expect(page.locator('#last_name')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#confirm_password')).toBeVisible();
  });

  test('shows error when passwords do not match', async ({ page }) => {
    await page.goto('/register?email=test@example.com');
    await page.fill('#first_name', 'Jean');
    await page.fill('#last_name', 'Dupont');
    await page.fill('#password', 'Password123!');
    await page.fill('#confirm_password', 'DifferentPassword!');
    await page.click('button[type="submit"]');
    await expect(page.locator('.bg-red-50')).toBeVisible();
  });

  test('password toggle shows and hides password', async ({ page }) => {
    await page.goto('/register?email=test@example.com');
    await page.fill('#password', 'test_toggle_value');
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
    const toggleBtn = page.locator('#password').locator('..').locator('button');
    const count = await toggleBtn.count();
    if (count === 0) test.skip();
    await toggleBtn.click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'text');
    await toggleBtn.click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
  });

  test('has link to login page', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('a[href="/login"]')).toBeVisible();
  });
});

test.describe('Choose account type page', () => {
  test('shows both account type options', async ({ page }) => {
    await page.goto('/choose_type');
    await expect(page.getByRole('button', { name: /Particulier|Individual/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Entreprise|Company/i })).toBeVisible();
  });

  test('selecting Particulier shows basic info intro', async ({ page }) => {
    await page.goto('/choose_type');
    await page.getByRole('button', { name: /Particulier|Individual/i }).click();
    await expect(page.getByText(/Informations de base|Basic information/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Ignorer pour l'instant|Skip for now/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Suivant|Next|Let's go)$/i })).toBeVisible();
  });

  test('shows account type title and subtitle', async ({ page }) => {
    await page.goto('/choose_type');
    await expect(page.getByRole('heading', { name: /type de compte|account type/i })).toBeVisible();
    await expect(page.getByText(/n'influence pas|does not affect/i)).toBeVisible();
    // Card descriptions are shown under each option
    await expect(page.getByText(/Je cherche du travail|looking for work/i)).toBeVisible();
  });
});
