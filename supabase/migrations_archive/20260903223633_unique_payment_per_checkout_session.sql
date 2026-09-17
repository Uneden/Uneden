-- One payment row per Stripe checkout session. Safe to enforce here because the
-- row is inserted right after the session is created, before the customer pays:
-- a conflict means we are replaying a session we already recorded, never that
-- money was captured without a record.
create unique index if not exists payments_stripe_checkout_session_id_key
  on public.payments (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
