
CREATE TABLE IF NOT EXISTS service_favorites (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_service_favorites_user ON service_favorites(user_id);
