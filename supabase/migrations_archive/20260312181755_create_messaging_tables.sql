
-- ============================================================
-- CHAT ROOMS
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_room (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT,
  is_group   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CHAT ROOM MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_room_member (
  chat_room_id UUID NOT NULL REFERENCES chat_room(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived  BOOLEAN NOT NULL DEFAULT FALSE,
  is_muted     BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (chat_room_id, user_id)
);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_room_id         UUID NOT NULL REFERENCES chat_room(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content              TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at              TIMESTAMPTZ,
  edited_at            TIMESTAMPTZ,
  pinned_at            TIMESTAMPTZ,
  deleted_at           TIMESTAMPTZ,
  replied_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  client_temp_id       TEXT,
  reactions            JSONB NOT NULL DEFAULT '[]'::JSONB
);

CREATE INDEX IF NOT EXISTS messages_chat_room_id_idx ON messages(chat_room_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx   ON messages(chat_room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_user_id_idx      ON messages(user_id);

-- ============================================================
-- TYPING INDICATORS
-- ============================================================
CREATE TABLE IF NOT EXISTS typing_indicators (
  chat_room_id UUID NOT NULL REFERENCES chat_room(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_room_id, user_id)
);

-- ============================================================
-- USER PRESENCE
-- ============================================================
CREATE TABLE IF NOT EXISTS user_presence (
  user_id   UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BLOCKED USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_user_id)
);

-- ============================================================
-- USER REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS user_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reported_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- RPC: get_or_create_direct_chat
-- Returns the chat_room id for a 1-to-1 conversation between
-- the calling user and other_user_id, creating it if needed.
-- ============================================================
CREATE OR REPLACE FUNCTION get_or_create_direct_chat(other_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_user UUID := auth.uid();
  v_room_id      UUID;
BEGIN
  -- Look for an existing direct (non-group) chat shared by both users
  SELECT crm1.chat_room_id INTO v_room_id
  FROM chat_room_member crm1
  JOIN chat_room_member crm2
    ON crm1.chat_room_id = crm2.chat_room_id
  JOIN chat_room cr
    ON cr.id = crm1.chat_room_id
  WHERE crm1.user_id = v_current_user
    AND crm2.user_id = other_user_id
    AND cr.is_group = FALSE
  LIMIT 1;

  IF v_room_id IS NOT NULL THEN
    RETURN v_room_id;
  END IF;

  -- Create a new direct chat room
  INSERT INTO chat_room (is_group) VALUES (FALSE) RETURNING id INTO v_room_id;

  -- Add both members
  INSERT INTO chat_room_member (chat_room_id, user_id)
  VALUES (v_room_id, v_current_user), (v_room_id, other_user_id)
  ON CONFLICT DO NOTHING;

  RETURN v_room_id;
END;
$$;

-- ============================================================
-- ENABLE REALTIME on required tables
-- ============================================================
ALTER TABLE messages          REPLICA IDENTITY FULL;
ALTER TABLE chat_room_member  REPLICA IDENTITY FULL;
ALTER TABLE typing_indicators REPLICA IDENTITY FULL;
ALTER TABLE user_presence     REPLICA IDENTITY FULL;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- chat_room: members can see their rooms
ALTER TABLE chat_room ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_room_select ON chat_room FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_room_member
      WHERE chat_room_id = chat_room.id AND user_id = auth.uid()
    )
  );

-- chat_room_member: users can see members of rooms they belong to
ALTER TABLE chat_room_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_select ON chat_room_member FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_room_member m2
      WHERE m2.chat_room_id = chat_room_member.chat_room_id AND m2.user_id = auth.uid()
    )
  );
CREATE POLICY crm_update_own ON chat_room_member FOR UPDATE
  USING (user_id = auth.uid());

-- messages: room members can read; sender can insert/update own messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY msg_select ON messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_room_member
      WHERE chat_room_id = messages.chat_room_id AND user_id = auth.uid()
    )
  );
CREATE POLICY msg_insert ON messages FOR INSERT
  WITH CHECK (
    user_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM chat_room_member
      WHERE chat_room_id = messages.chat_room_id AND user_id = auth.uid()
    )
  );
CREATE POLICY msg_update ON messages FOR UPDATE
  USING (user_id = auth.uid());

-- typing_indicators: room members can read/upsert
ALTER TABLE typing_indicators ENABLE ROW LEVEL SECURITY;
CREATE POLICY typing_select ON typing_indicators FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_room_member
      WHERE chat_room_id = typing_indicators.chat_room_id AND user_id = auth.uid()
    )
  );
CREATE POLICY typing_upsert ON typing_indicators FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY typing_update ON typing_indicators FOR UPDATE
  USING (user_id = auth.uid());
CREATE POLICY typing_delete ON typing_indicators FOR DELETE
  USING (user_id = auth.uid());

-- user_presence: all authenticated users can read; own row upsert
ALTER TABLE user_presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY presence_select ON user_presence FOR SELECT
  USING (auth.uid() IS NOT NULL);
CREATE POLICY presence_insert ON user_presence FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY presence_update ON user_presence FOR UPDATE
  USING (user_id = auth.uid());

-- blocked_users: own rows only
ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY blocked_select ON blocked_users FOR SELECT
  USING (blocker_id = auth.uid());
CREATE POLICY blocked_insert ON blocked_users FOR INSERT
  WITH CHECK (blocker_id = auth.uid());
CREATE POLICY blocked_delete ON blocked_users FOR DELETE
  USING (blocker_id = auth.uid());

-- user_reports: insert for authenticated, read own
ALTER TABLE user_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY reports_insert ON user_reports FOR INSERT
  WITH CHECK (reporter_id = auth.uid());
CREATE POLICY reports_select ON user_reports FOR SELECT
  USING (reporter_id = auth.uid());
