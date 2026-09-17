
CREATE TABLE dispute_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  dispute_id UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  attachments JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX dispute_messages_dispute_id_idx ON dispute_messages(dispute_id);
CREATE INDEX dispute_messages_created_at_idx ON dispute_messages(created_at);
