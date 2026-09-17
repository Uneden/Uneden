import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

// Charger .env.test automatiquement pour les tests Playwright
dotenv.config({ path: path.resolve(__dirname, '.env.test') });

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  timeout: 120000,
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
    // The suite asserts French UI text; Chromium defaults to en-US otherwise.
    locale: 'fr-CA',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30000,
  },

  projects: [
    // Setup project: logs in once and saves auth state
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // All other tests reuse the saved auth state (user1 = seller)
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
});
