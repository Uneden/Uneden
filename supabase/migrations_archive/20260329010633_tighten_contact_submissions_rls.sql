
DROP POLICY IF EXISTS "Anyone can submit contact form" ON contact_submissions;

CREATE POLICY "Anyone can submit contact form"
  ON contact_submissions
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    char_length(trim(first_name)) > 0
    AND char_length(trim(last_name)) > 0
    AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND char_length(trim(message)) > 0
    AND subject IN ('account', 'payment', 'dispute', 'listing', 'safety', 'partnership', 'other')
  );
