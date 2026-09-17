
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_read_own_bookings"
ON bookings FOR SELECT
USING (auth.uid() = worker_id OR auth.uid() = client_id);
