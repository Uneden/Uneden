
-- 1. Sync existing data from users → profiles
UPDATE profiles p
SET
  bio          = u.bio,
  full_name    = COALESCE(NULLIF(u.full_name, ''), p.full_name),
  company_name = COALESCE(NULLIF(u.company_name, ''), p.company_name),
  account_type = COALESCE(NULLIF(u.account_type, ''), p.account_type),
  avatar_url   = COALESCE(NULLIF(u.avatar, ''), p.avatar_url)
FROM users u
WHERE p.id = u.id
  AND u.bio IS NOT NULL
  AND u.bio <> '';

-- 2. Trigger function: keep profiles in sync when users is updated
CREATE OR REPLACE FUNCTION sync_user_to_profile()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE profiles
  SET
    bio          = COALESCE(NULLIF(NEW.bio, ''), bio),
    full_name    = COALESCE(NULLIF(NEW.full_name, ''), full_name),
    company_name = COALESCE(NULLIF(NEW.company_name, ''), company_name),
    account_type = COALESCE(NULLIF(NEW.account_type, ''), account_type),
    avatar_url   = COALESCE(NULLIF(NEW.avatar, ''), avatar_url)
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Attach trigger on users UPDATE
DROP TRIGGER IF EXISTS trg_sync_user_to_profile ON users;
CREATE TRIGGER trg_sync_user_to_profile
AFTER UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION sync_user_to_profile();
