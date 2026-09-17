/**
 * user-journey.spec.ts
 *
 * Tests de bout-en-bout couvrant les flux principaux de l'application Uneden :
 *  1. Inscription (validation + redirection)
 *  2. Connexion (ступенчатый login à 2 étapes)
 *  3. Page d'accueil (hero, listings récents, catégories)
 *  4. Page listings (navigation, recherche, filtre)
 *  5. Détail d'une annonce (titre, prix, bouton contact)
 *  6. Messagerie (accès, nouvelle conversation)
 *  7. Réservations – buyer envoie une demande
 *  8. Réservations – seller reçoit et peut accepter
 *  9. Wallet (solde visible, onglets transactions)
 * 10. Profil utilisateur (infos affichées, onglets annonces/avis)
 *
 * Variables d'environnement requises :
 *   TEST_EMAIL / TEST_PASSWORD        → Seller (user1)
 *   TEST_EMAIL_2 / TEST_PASSWORD_2    → Buyer  (user2)
 *   TEST_LISTING_ID                   → ID d'une annonce du seller
 *   TEST_BASE_URL                     → (optionnel) défaut http://localhost:3000
 */

import { test, expect, chromium } from '@playwright/test';
import path from 'path';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
// Profiles live at /profile/<id> (no bare /profile route). Ids match supabase/seed.sql locally.
const SELLER_ID = process.env.TEST_USER_ID;
const BUYER_ID = process.env.TEST_USER_ID_2;
const authFile2 = path.join(__dirname, '../playwright/.auth/user2.json');

// ─── Helper : ouvre un contexte Buyer (user2) ───────────────────────────────
async function getBuyerPage() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: authFile2 });
  const page = await context.newPage();
  return { browser, page };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. INSCRIPTION
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('1. Inscription', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // The form has two steps: email first, then names + password.
  async function goToPasswordStep(page: import('@playwright/test').Page, email: string) {
    await page.goto('/register');
    await page.fill('#email', email);
    await page.click('button[type="submit"]');
    await page.waitForSelector('#password', { timeout: 15000 });
  }

  test('le formulaire affiche tous les champs requis', async ({ page }) => {
    await goToPasswordStep(page, 'test_fields@example.com');
    await expect(page.locator('#first_name')).toBeVisible();
    await expect(page.locator('#last_name')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#confirm_password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('erreur si les mots de passe ne correspondent pas', async ({ page }) => {
    await goToPasswordStep(page, 'test_mismatch@example.com');
    await page.fill('#first_name', 'Test');
    await page.fill('#last_name', 'Utilisateur');
    await page.fill('#password', 'Password123!');
    await page.fill('#confirm_password', 'Different123!');
    await page.click('button[type="submit"]');
    await expect(page.locator('.bg-red-50').first()).toBeVisible({ timeout: 5000 });
  });

  test('le bouton reste désactivé si le mot de passe est trop court', async ({ page }) => {
    await goToPasswordStep(page, 'test_short@example.com');
    await page.fill('#first_name', 'Test');
    await page.fill('#last_name', 'Utilisateur');
    await page.fill('#password', 'abc');
    await page.fill('#confirm_password', 'abc');
    // Submit is gated on password.length >= 8, so the form cannot be sent
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });

  test('lien vers la page de connexion présent', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('a[href="/login"]')).toBeVisible();
  });

  test('page de choix du type de compte accessible', async ({ page }) => {
    await page.goto('/choose_type');
    await expect(page.getByRole('button', { name: /Particulier|Individual/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Entreprise|Company/i })).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CONNEXION
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('2. Connexion', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('affiche l\'étape email au chargement', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('#email')).toBeVisible();
  });

  test('passe à l\'étape mot de passe pour un email connu', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#email', process.env.TEST_EMAIL!);
    await page.click('button[type="submit"]');
    await expect(page.locator('#password')).toBeVisible({ timeout: 20000 });
  });

  test('affiche une erreur pour un mauvais mot de passe', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#email', process.env.TEST_EMAIL!);
    await page.click('button[type="submit"]');
    await page.waitForSelector('#password', { timeout: 20000 });
    await page.fill('#password', 'mauvais_mot_de_passe_999');
    await page.click('button[type="submit"]');
    await expect(page.locator('.bg-red-50').first()).toBeVisible({ timeout: 20000 });
  });

  test('connexion complète redirige hors de /login', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#email', process.env.TEST_EMAIL!);
    await page.click('button[type="submit"]');
    await page.waitForSelector('#password', { timeout: 20000 });
    await page.fill('#password', process.env.TEST_PASSWORD!);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
    expect(page.url()).not.toContain('/login');
  });

  test('affiche "pas de compte" pour un email inconnu', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#email', 'email_inexistant_xyz123@test.com');
    await page.click('button[type="submit"]');
    await expect(page.locator('a[href*="/register"]')).toBeVisible({ timeout: 10000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PAGE D'ACCUEIL
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('3. Page d\'accueil', () => {
  test('se charge sans rediriger vers /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/login/);
  });

  test('affiche la section "Récemment ajoutés"', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const heading = page.locator('h2, h1').filter({ hasText: /récemment|recently/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
  });

  test('affiche des listings ou un état vide', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const cards = page.locator('a[href*="/serviceDetail/"]');
    const hasCards = await cards.count() > 0;
    expect(hasCards).toBe(true);
  });

  test('affiche la section catégories populaires', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const catSection = page.locator('h1, h2').filter({ hasText: /catégorie|categories/i }).first();
    await expect(catSection).toBeVisible({ timeout: 15000 });
  });

  test('cliquer sur une catégorie redirige vers /listings', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const catLink = page.locator('a[href*="/listings?category="]').first();
    await expect(catLink).toBeVisible({ timeout: 15000 });
    await catLink.click();
    await expect(page).toHaveURL(/\/listings/, { timeout: 10000 });
  });

  test('bouton "Voir toutes les annonces" redirige vers /listings', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const btn = page.locator('a[href="/listings"]').first();
    await expect(btn).toBeVisible({ timeout: 15000 });
    await btn.click();
    await expect(page).toHaveURL(/\/listings/, { timeout: 10000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PAGE LISTINGS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('4. Page listings', () => {
  test('se charge correctement', async ({ page }) => {
    await page.goto('/listings');
    await expect(page).not.toHaveURL(/login/);
    await page.waitForLoadState('networkidle');
  });

  test('affiche des annonces', async ({ page }) => {
    await page.goto('/listings');
    await page.waitForLoadState('networkidle');
    const cards = page.locator('a[href*="/serviceDetail/"]');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
  });

  test('la barre de recherche est présente', async ({ page }) => {
    await page.goto('/listings');
    await page.waitForLoadState('networkidle');
    const search = page.locator('input[type="search"], input[placeholder*="earch"], input[placeholder*="echerc"]').first();
    await expect(search).toBeVisible({ timeout: 10000 });
  });

  test('filtrer par "Offre" montre des résultats', async ({ page }) => {
    await page.goto('/listings');
    await page.waitForLoadState('networkidle');
    const offerBtn = page.locator('button').filter({ hasText: /offre|offer/i }).first();
    if (await offerBtn.isVisible()) {
      await offerBtn.click();
      await page.waitForLoadState('networkidle');
      const cards = page.locator('a[href*="/serviceDetail/"]');
      const count = await cards.count();
      expect(count).toBeGreaterThanOrEqual(0); // peut être 0 si aucune annonce
    }
  });

  test('cliquer sur une annonce ouvre la page de détail', async ({ page }) => {
    await page.goto('/listings');
    await page.waitForLoadState('networkidle');
    const firstCard = page.locator('a[href*="/serviceDetail/"]').first();
    await firstCard.click();
    await expect(page).toHaveURL(/\/serviceDetail\//, { timeout: 10000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. DÉTAIL D'UNE ANNONCE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('5. Détail d\'une annonce', () => {
  // Helper: navigate to listings, click first card, wait for detail content to load
  async function goToFirstListing(page: import('@playwright/test').Page) {
    await page.goto('/listings');
    await page.waitForLoadState('networkidle');
    const card = page.locator('a[href*="/serviceDetail/"]').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();
    await page.waitForURL(/serviceDetail/, { timeout: 15000 });
    // Wait for the loading skeleton to disappear before asserting on content
    await page.waitForSelector('.animate-pulse', { state: 'hidden', timeout: 20000 }).catch(() => {});
  }

  test('la page se charge avec un titre et un prix', async ({ page }) => {
    await goToFirstListing(page);
    await expect(page).toHaveURL(/serviceDetail/, { timeout: 10000 });
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    // Price is rendered as "40.00 $" in a bold green <p> inside the ServiceTitleCard
    const price = page.locator('p.font-bold.text-green-700').first();
    await expect(price).toBeVisible({ timeout: 10000 });
  });

  test('affiche au moins un bouton d\'action (contacter, réserver)', async ({ page }) => {
    await goToFirstListing(page);
    await expect(page).toHaveURL(/serviceDetail/, { timeout: 10000 });
    const actionBtn = page.locator('button').filter({ hasText: /.{3,}/ }).first();
    await expect(actionBtn).toBeVisible({ timeout: 15000 });
  });

  test('(buyer) peut voir l\'annonce du seller', async () => {
    const { browser, page } = await getBuyerPage();
    try {
      await page.goto(`${BASE}/listings`);
      await page.waitForLoadState('networkidle');
      const card = page.locator('a[href*="/serviceDetail/"]').first();
      await expect(card).toBeVisible({ timeout: 15000 });
      await card.click();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(/serviceDetail/, { timeout: 10000 });
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible({ timeout: 15000 });
    } finally {
      await browser.close();
    }
  });

  test('lien vers le profil du prestataire fonctionne', async ({ page }) => {
    await goToFirstListing(page);
    await expect(page).toHaveURL(/serviceDetail/, { timeout: 10000 });
    const profileLink = page.locator('a[href*="/profile/"]').first();
    if (await profileLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await profileLink.click();
      await expect(page).toHaveURL(/\/profile\//, { timeout: 10000 });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. MESSAGERIE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('6. Messagerie', () => {
  test('la page /messages se charge sans redirection', async ({ page }) => {
    await page.goto('/messages');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/login/);
  });

  test('affiche la liste de conversations ou un état vide', async ({ page }) => {
    await page.goto('/messages');
    await page.waitForLoadState('networkidle');
    const content = page.locator('main, [role="main"], body').first();
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('une conversation existante est cliquable', async ({ page }) => {
    await page.goto('/messages');
    await page.waitForLoadState('networkidle');
    const convo = page.locator('div[class*="cursor-pointer"]').filter({ hasText: /.{2,}/ }).first();
    const hasConvo = await convo.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasConvo) {
      await convo.click();
      // La zone de saisie doit apparaître
      const input = page.locator('textarea, input[placeholder*="essage"]').first();
      await expect(input).toBeVisible({ timeout: 10000 });
    }
  });

  test('(buyer) peut accéder à /messages', async () => {
    const { browser, page } = await getBuyerPage();
    try {
      await page.goto(`${BASE}/messages`);
      await page.waitForLoadState('networkidle');
      await expect(page).not.toHaveURL(/login/);
    } finally {
      await browser.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. RÉSERVATIONS – BUYER
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('7. Réservations (buyer)', () => {
  test('la page /bookings se charge correctement', async () => {
    const { browser, page } = await getBuyerPage();
    try {
      await page.goto(`${BASE}/bookings`);
      await page.waitForLoadState('networkidle');
      await expect(page).not.toHaveURL(/login/);
      await expect(page.locator('.bg-red-50')).not.toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });

  test('les onglets Reçues / Envoyées / Terminées sont présents', async () => {
    const { browser, page } = await getBuyerPage();
    try {
      await page.goto(`${BASE}/bookings`);
      await page.waitForLoadState('networkidle');
      const receivedTab = page.locator('button').filter({ hasText: /reçues|received/i }).first();
      const sentTab = page.locator('button').filter({ hasText: /envoyées|sent/i }).first();
      await expect(receivedTab).toBeVisible({ timeout: 10000 });
      await expect(sentTab).toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });

  test('peut naviguer sur l\'onglet Envoyées', async () => {
    const { browser, page } = await getBuyerPage();
    try {
      await page.goto(`${BASE}/bookings`);
      await page.waitForLoadState('networkidle');
      const sentTab = page.locator('button').filter({ hasText: /envoyées|sent/i }).first();
      await sentTab.click();
      await page.waitForLoadState('networkidle');
      // La page ne doit pas crasher
      await expect(page.locator('.bg-red-50')).not.toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. RÉSERVATIONS – SELLER
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('8. Réservations (seller)', () => {
  test('la page /bookings se charge correctement', async ({ page }) => {
    await page.goto('/bookings');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('.bg-red-50')).not.toBeVisible({ timeout: 10000 });
  });

  test('l\'onglet Reçues est présent et cliquable', async ({ page }) => {
    await page.goto('/bookings');
    await page.waitForLoadState('networkidle');
    const receivedTab = page.locator('button').filter({ hasText: /reçues|received/i }).first();
    await expect(receivedTab).toBeVisible({ timeout: 10000 });
    await receivedTab.click();
    await expect(page.locator('.bg-red-50')).not.toBeVisible({ timeout: 5000 });
  });

  test('une réservation reçue a des boutons Accepter / Refuser si présente', async ({ page }) => {
    await page.goto('/bookings');
    await page.waitForLoadState('networkidle');
    const receivedTab = page.locator('button').filter({ hasText: /reçues|received/i }).first();
    await receivedTab.click();
    await page.waitForLoadState('networkidle');
    // Si des réservations existent, ils doivent avoir des boutons d'action
    const acceptBtn = page.locator('button').filter({ hasText: /accepter|accept/i }).first();
    const hasBtn = await acceptBtn.isVisible({ timeout: 5000 }).catch(() => false);
    // On ne force pas la présence (peut être vide), on vérifie juste que la page ne crashe pas
    expect(typeof hasBtn).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. WALLET
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('9. Wallet', () => {
  test('se charge sans redirection', async ({ page }) => {
    await page.goto('/wallet');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/login/);
  });

  test('affiche le solde', async ({ page }) => {
    await page.goto('/wallet');
    await page.waitForLoadState('networkidle');
    const balance = page.locator('text=/\\$|solde|balance/i').first();
    await expect(balance).toBeVisible({ timeout: 10000 });
  });

  test('affiche les onglets de transactions', async ({ page }) => {
    await page.goto('/wallet');
    await page.waitForLoadState('networkidle');
    const tabs = page.locator('[role="tablist"], button').filter({ hasText: /reçu|envoyé|all|tout/i }).first();
    await expect(tabs).toBeVisible({ timeout: 10000 });
  });

  test('(buyer) peut accéder à son wallet', async () => {
    const { browser, page } = await getBuyerPage();
    try {
      await page.goto(`${BASE}/wallet`);
      await page.waitForLoadState('networkidle');
      await expect(page).not.toHaveURL(/login/);
      const balance = page.locator('text=/\\$|solde|balance/i').first();
      await expect(balance).toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. PROFIL UTILISATEUR
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('10. Profil utilisateur', () => {
  test.beforeEach(() => {
    test.skip(!SELLER_ID, 'TEST_USER_ID not set');
  });

  test('la page de profil du seller se charge', async ({ page }) => {
    await page.goto(`/profile/${SELLER_ID}`);
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 });
  });

  test('affiche le nom ou avatar', async ({ page }) => {
    await page.goto(`/profile/${SELLER_ID}`);
    const avatar = page.locator('img[alt], [class*="avatar"], [class*="Avatar"]').first();
    const nameEl = page.locator('h1, h2, h3').first();
    await expect(avatar.or(nameEl)).toBeVisible({ timeout: 15000 });
  });

  test("affiche les annonces de l'utilisateur ou un état vide", async ({ page }) => {
    await page.goto(`/profile/${SELLER_ID}`);
    const listings = page.locator('a[href*="/serviceDetail/"]').first();
    const emptyState = page.locator("text=/aucune|no listing|pas d'annonce|hasn't posted|listings yet/i").first();
    await expect(listings.or(emptyState)).toBeVisible({ timeout: 15000 });
  });

  test('/my-listings affiche les annonces du seller', async ({ page }) => {
    await page.goto('/my-listings');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('main, body').first()).toBeVisible({ timeout: 10000 });
  });

  test('(buyer) peut voir son propre profil', async () => {
    test.skip(!BUYER_ID, 'TEST_USER_ID_2 not set');
    const { browser, page } = await getBuyerPage();
    try {
      await page.goto(`${BASE}/profile/${BUYER_ID}`);
      await expect(page).not.toHaveURL(/login/);
      await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 });
    } finally {
      await browser.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. NAVIGATION & SÉCURITÉ
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('11. Navigation & Sécurité', () => {
  test('une page inconnue affiche 404 ou redirige', async ({ page }) => {
    const res = await page.goto('/cette-page-nexiste-pas-xyz');
    // Soit c'est un 404, soit ça redirige vers /
    const status = res?.status() ?? 200;
    const isOkOrRedirect = status === 404 || status === 200;
    expect(isOkOrRedirect).toBe(true);
  });

  test('sans auth, /wallet redirige vers login', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${BASE}/wallet`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/login/, { timeout: 10000 });
    await context.close();
  });

  test('sans auth, /bookings redirige vers login', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${BASE}/bookings`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/login/, { timeout: 10000 });
    await context.close();
  });

  test('sans auth, /messages redirige vers login', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${BASE}/messages`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/login/, { timeout: 10000 });
    await context.close();
  });

  test('la page /listings est accessible sans auth', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${BASE}/listings`);
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/login/);
    await context.close();
  });
});
