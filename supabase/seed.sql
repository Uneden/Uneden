-- ============================================================================
-- Local / CI seed. Applied by `supabase start` and `supabase db reset` only,
-- never against production.
--
-- Creates the reference data the app needs (categories) plus the fixtures the
-- Playwright suite expects (see frontend/.env.test):
--   seller@test.local / Test-seller-1234  → TEST_EMAIL / TEST_PASSWORD
--   buyer@test.local  / Test-buyer-1234   → TEST_EMAIL_2 / TEST_PASSWORD_2
--   listing 00000000-0000-4000-8000-000000000001 (owned by the seller)
--                                         → TEST_LISTING_ID
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Categories (same ids as production so category links behave identically)
-- ---------------------------------------------------------------------------
INSERT INTO public.categories (id, name, image_url) VALUES
  ('c9ad5b3e-f4ba-4487-9cef-5e9e38f8caf2', 'Automotive', '/Categories/car_support.avif'),
  ('7c50cd70-aad9-4074-8c28-5a9f6b04948a', 'Custom & Local Services', 'https://images.unsplash.com/photo-1555244162-803834f70033?w=600&q=80'),
  ('b2f53351-9e09-4ae4-a1d6-d0b4f9bc2bb7', 'Home Services', '/Categories/cleaning.jpg'),
  ('c9f3a720-6ff5-44cb-b5f6-64d507ef59f1', 'Lessons & Creative Services', 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=600&q=80'),
  ('01448229-3b54-4423-aee4-4de7d7099a57', 'Moving & Delivery', '/Categories/moving.webp'),
  ('224b01a7-921c-4746-915e-bd6523449515', 'Personal & Care Services', '/Categories/petcaring.png'),
  ('868d848d-6671-4a97-ba54-3f8f8978383c', 'Renovation & Outdoor', '/Categories/renovation.webp'),
  ('157704d2-242c-4391-9dc4-485d3ddc2602', 'Repairs & Maintenance', '/Categories/home_repair.jpg'),
  ('1f1545fc-524c-4f68-9bcc-cae9aa31adda', 'Tech & Digital Help', '/Categories/tech_support.webp')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Test accounts. Inserting into auth.users fires on_auth_user_created, which
-- populates public.users and public.profiles.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token,
  email_change, email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token
) VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-00000000a001',
    'authenticated', 'authenticated',
    'seller@test.local', extensions.crypt('Test-seller-1234', extensions.gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}',
    '{"full_name":"Test Seller","account_type":"person","city":"Montréal","province":"QC","onboarding_intro_completed":true}',
    now(), now(), '', '',
    '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-00000000a002',
    'authenticated', 'authenticated',
    'buyer@test.local', extensions.crypt('Test-buyer-1234', extensions.gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}',
    '{"full_name":"Test Buyer","account_type":"person","city":"Montréal","province":"QC","onboarding_intro_completed":true}',
    now(), now(), '', '',
    '', '', '', '', '', ''
  )
ON CONFLICT (id) DO NOTHING;

-- Email/password sign-in needs a matching identity row.
INSERT INTO auth.identities (
  id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at
)
SELECT
  gen_random_uuid(), u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  now(), now(), now()
FROM auth.users u
WHERE u.email IN ('seller@test.local', 'buyer@test.local')
ON CONFLICT (provider_id, provider) DO NOTHING;

-- Skip the onboarding flow for both accounts.
UPDATE public.users
SET profile_completed = true
WHERE email IN ('seller@test.local', 'buyer@test.local');

-- ---------------------------------------------------------------------------
-- One active listing owned by the seller, for booking / favorites tests.
-- ---------------------------------------------------------------------------
INSERT INTO public.services (
  id, user_id, title, description, category, category_id, price, pricing_mode,
  location, city, address, latitude, longitude, type, availability, language,
  mobility, duration, is_active, is_public
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-00000000a001',
  'Test listing — home cleaning',
  'Seeded listing used by the end-to-end test suite.',
  'Home Services', 'b2f53351-9e09-4ae4-a1d6-d0b4f9bc2bb7',
  40, 'fixed',
  'Montréal, QC', 'Montréal', '1 Rue Test, Montréal, QC', 45.5017, -73.5673,
  'offer', 'weekdays', 'fr', 'travels', '2h',
  true, true
)
ON CONFLICT (id) DO NOTHING;
