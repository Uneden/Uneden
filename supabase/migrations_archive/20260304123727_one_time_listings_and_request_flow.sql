
-- One-time listing support on services
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS is_one_time BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Bookings: client description, mutual completion flags
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS client_description TEXT,
  ADD COLUMN IF NOT EXISTS completed_by_worker BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS completed_by_client BOOLEAN DEFAULT false;

-- Wallet per user (internal balance tracker)
CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance NUMERIC DEFAULT 0,
  total_earned NUMERIC DEFAULT 0,
  total_spent NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transaction history
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount NUMERIC NOT NULL,
  description TEXT,
  other_user_name TEXT,
  listing_title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_booking_id ON transactions(booking_id);

-- Ensure existing users get a wallet row
INSERT INTO wallets (user_id, balance, total_earned, total_spent)
SELECT id, 0, 0, 0 FROM users
ON CONFLICT (user_id) DO NOTHING;
