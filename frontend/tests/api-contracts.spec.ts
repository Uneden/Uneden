import { test, expect, type APIRequestContext } from '@playwright/test';

// API-level checks against the real backend + local Postgres: they catch what
// unit tests can't, i.e. values the database itself rejects (column sizes,
// SQL syntax). The UI form can't submit in CI (Google Places), so these call
// the API directly with the seeded seller account.

const API = process.env.TEST_API_URL || 'http://localhost:5000/api';
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

async function signIn(request: APIRequestContext, email: string, password: string) {
  const res = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: SUPABASE_ANON_KEY },
    data: { email, password },
  });
  expect(res.ok(), `sign-in as ${email}`).toBeTruthy();
  const body = await res.json();
  return { Authorization: `Bearer ${body.access_token}` };
}

const tag = (label: string) => `${label} ${'x'.repeat(80)}`.slice(0, 80);

function listingPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'offer',
    title: 'Cours de dessin pour enfants (4 à 12 ans) — API contract test',
    description: 'Automated API contract test. Please ignore.',
    category: 'Lessons & Creative Services',
    // 5 tags of 80 chars: ~412 chars in services.subcategory (was varchar(100)).
    listing_tags: [tag('Cours de dessin'), tag('Arts plastiques'), tag('Peinture'), tag('Parascolaire'), tag('Enfants')],
    pricing_mode: 'fixed',
    price: 94,
    locations: [{ address: '1 Rue Test, Longueuil, QC J4K 2J5', city: 'Longueuil', lat: 45.53, lng: -73.51, location: 'Longueuil, QC' }],
    is_public: false,
    ...overrides,
  };
}

test.describe('API contracts', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(() => {
    expect(SUPABASE_ANON_KEY, 'SUPABASE_ANON_KEY must be set (see .env.test.example)').not.toBe('');
  });

  test('a listing with the maximum number of long tags can be published and edited', async ({ request }) => {
    const auth = await signIn(request, process.env.TEST_EMAIL!, process.env.TEST_PASSWORD!);

    const created = await request.post(`${API}/services`, { headers: auth, data: listingPayload() });
    expect(created.status(), await created.text()).toBe(201);
    const listing = await created.json();
    expect(listing.listing_tags).toHaveLength(5);

    try {
      const edited = await request.put(`${API}/services/${listing.id}`, {
        headers: auth,
        data: { listing_tags: [...listing.listing_tags].reverse() },
      });
      expect(edited.status(), await edited.text()).toBe(200);
    } finally {
      await request.delete(`${API}/services/${listing.id}`, { headers: auth });
    }
  });

  test('out-of-range listing fields are a 400, not a 500', async ({ request }) => {
    const auth = await signIn(request, process.env.TEST_EMAIL!, process.env.TEST_PASSWORD!);

    for (const overrides of [
      { urgency: 'u'.repeat(60) },
      { pricing_mode: 'hourly', price: 25, estimated_hours: 5_000_000 },
      { pricing_mode: 'quote', price: undefined, deposit_enabled: true, deposit_type: 'fixed', deposit_value: 500_000_000 },
    ]) {
      const res = await request.post(`${API}/services`, { headers: auth, data: listingPayload(overrides) });
      expect(res.status(), JSON.stringify(overrides)).toBe(400);
    }
  });

  test('billing addresses: validation, default switch and deleting the default', async ({ request }) => {
    const auth = await signIn(request, process.env.TEST_EMAIL!, process.env.TEST_PASSWORD!);
    const list = async () => {
      const res = await request.get(`${API}/billing-addresses`, { headers: auth });
      expect(res.ok()).toBeTruthy();
      return (await res.json()) as Array<{ id: string; label: string; is_default: boolean; province: string; postal_code: string }>;
    };

    // Leftovers from an interrupted run would hit the 2-address cap.
    for (const leftover of (await list()).filter((a) => a.label === 'E2E')) {
      await request.delete(`${API}/billing-addresses/${leftover.id}`, { headers: auth });
    }
    const before = await list();
    expect(before.length).toBeLessThan(2);

    const invalid = await request.post(`${API}/billing-addresses`, {
      headers: auth,
      data: { label: 'E2E', address_line1: '1 Rue Test', city: 'Longueuil', province: 'Province de Québec', postal_code: 'J4K 2J5' },
    });
    expect(invalid.status()).toBe(400);

    const missingPostal = await request.post(`${API}/billing-addresses`, {
      headers: auth,
      data: { label: 'E2E', address_line1: '1 Rue Test', city: 'Longueuil', province: 'QC' },
    });
    expect(missingPostal.status()).toBe(400);

    const created = await request.post(`${API}/billing-addresses`, {
      headers: auth,
      data: { label: 'E2E', address_line1: '1 Rue Test', city: 'Longueuil', province: 'Québec', postal_code: 'j4k2j5' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const address = await created.json();
    expect(address.province).toBe('QC');
    expect(address.postal_code).toBe('J4K 2J5');

    // An unknown id must not clear the current default.
    const unknown = await request.post(`${API}/billing-addresses/00000000-0000-4000-8000-0000000000ff/default`, { headers: auth });
    expect(unknown.status()).toBe(404);
    expect((await list()).filter((a) => a.is_default)).toHaveLength(1);

    const makeDefault = await request.post(`${API}/billing-addresses/${address.id}/default`, { headers: auth });
    expect(makeDefault.ok()).toBeTruthy();

    // Deleting the default promotes the remaining address (was a SQL error).
    const removed = await request.delete(`${API}/billing-addresses/${address.id}`, { headers: auth });
    expect(removed.status(), await removed.text()).toBe(200);
    const after = await list();
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));
    if (after.length > 0) expect(after.filter((a) => a.is_default)).toHaveLength(1);
  });
});
