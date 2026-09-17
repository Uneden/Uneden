
-- Worker can customize a booking's price and leave a note for the client
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS worker_note       TEXT,
  ADD COLUMN IF NOT EXISTS custom_price      NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS last_modified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS modified_fields   TEXT[],
  -- Mutual cancellation for active bookings
  ADD COLUMN IF NOT EXISTS cancel_requested_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS cancel_reason     TEXT;
