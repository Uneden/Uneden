
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS address   TEXT,
  ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS city      TEXT;

-- Migrate existing rows: use location as city fallback
UPDATE services SET city = location WHERE city IS NULL AND location IS NOT NULL;
