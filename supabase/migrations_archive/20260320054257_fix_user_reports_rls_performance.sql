
DROP POLICY IF EXISTS "Users can submit reports" ON public.user_reports;
DROP POLICY IF EXISTS "reports_insert" ON public.user_reports;
DROP POLICY IF EXISTS "reports_select" ON public.user_reports;

CREATE POLICY "user_reports_select" ON public.user_reports
  FOR SELECT USING ((select auth.uid()) = reporter_id);

CREATE POLICY "user_reports_insert" ON public.user_reports
  FOR INSERT WITH CHECK ((select auth.uid()) = reporter_id);
