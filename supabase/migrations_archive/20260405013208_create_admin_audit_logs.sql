
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID        NOT NULL,
  admin_email TEXT        NOT NULL,
  action      TEXT        NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aal_admin_id    ON admin_audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_aal_action       ON admin_audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_aal_created_at   ON admin_audit_logs (created_at DESC);

-- Only admins should ever read this table; regular users never can
ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin audit logs: no direct user access" ON admin_audit_logs
  FOR ALL USING (false);
