
CREATE TABLE notification_preferences (
  user_id UUID PRIMARY KEY,
  email_messages  BOOLEAN NOT NULL DEFAULT TRUE,
  email_payments  BOOLEAN NOT NULL DEFAULT TRUE,
  email_listings  BOOLEAN NOT NULL DEFAULT TRUE,
  email_complaints BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
