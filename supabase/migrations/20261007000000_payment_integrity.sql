-- Database-level guarantees for money movements; the code relies on them
-- (ON CONFLICT ... DO NOTHING). Apply BEFORE deploying the matching backend.
-- Checked on 2026-10-07: production holds no duplicates for either index.

-- One credit per user per booking: the worker's earnings (or retained
-- deposit), the client's refund. finalizeCompletion runs from two places
-- (completion, late balance payment); concurrent runs could credit the
-- worker's wallet twice.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_credit_per_booking
  ON public.transactions (booking_id, user_id)
  WHERE type = 'credit' AND booking_id IS NOT NULL;

-- A Stripe PaymentIntent is recorded once.
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_payment_intent_id_key
  ON public.payments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
