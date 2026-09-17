
-- Services are public listings — anyone (authenticated or not) can read them.
-- Writes go exclusively through the backend API (service role key bypasses RLS).
CREATE POLICY "services_public_read"
  ON services
  FOR SELECT
  USING (true);
