-- One review per reviewer per booking, and one dispute per booking: the API
-- checked with a SELECT before inserting, so a double submit could create two.
-- It now relies on these indexes (ON CONFLICT ... DO NOTHING → 409).
-- Checked on 2026-10-08: production has no reviews and no disputes yet.
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_booking_reviewer
  ON public.reviews (booking_id, reviewer_id);

CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_per_booking
  ON public.disputes (booking_id);

-- A review always has a rating (the API stored NULL when it was missing).
ALTER TABLE public.reviews ALTER COLUMN rating SET NOT NULL;
