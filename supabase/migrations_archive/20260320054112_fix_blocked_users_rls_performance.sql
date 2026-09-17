
-- Drop all existing policies on blocked_users
DROP POLICY IF EXISTS "Users can see blocks involving them" ON public.blocked_users;
DROP POLICY IF EXISTS "blocked_select" ON public.blocked_users;
DROP POLICY IF EXISTS "blocked_insert" ON public.blocked_users;
DROP POLICY IF EXISTS "blocked_delete" ON public.blocked_users;
DROP POLICY IF EXISTS "Users can block others" ON public.blocked_users;
DROP POLICY IF EXISTS "Users can view their blocks" ON public.blocked_users;
DROP POLICY IF EXISTS "Users can delete their blocks" ON public.blocked_users;

-- Recreate with (select auth.uid()) to avoid per-row re-evaluation
CREATE POLICY "blocked_users_select" ON public.blocked_users
  FOR SELECT USING (
    (select auth.uid()) = blocker_id OR (select auth.uid()) = blocked_user_id
  );

CREATE POLICY "blocked_users_insert" ON public.blocked_users
  FOR INSERT WITH CHECK (
    (select auth.uid()) = blocker_id
  );

CREATE POLICY "blocked_users_delete" ON public.blocked_users
  FOR DELETE USING (
    (select auth.uid()) = blocker_id
  );
