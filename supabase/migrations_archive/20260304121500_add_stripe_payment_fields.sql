
-- Add Stripe-specific fields to payments table
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT,
  ADD COLUMN IF NOT EXISTS platform_fee INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transfer_group TEXT,
  ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'cad',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Add payment_status to bookings for quick lookup
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid';

-- Add index for quick payment lookup by booking
CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON payments(booking_id);
