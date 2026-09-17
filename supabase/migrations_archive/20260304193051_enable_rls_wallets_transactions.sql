
-- ── wallets ──────────────────────────────────────────────────────────────────
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

-- Users can read their own wallet
CREATE POLICY "wallets_select_own"
  ON public.wallets FOR SELECT
  USING (user_id = auth.uid());

-- Users cannot directly insert/update/delete — handled by backend (service role)

-- ── transactions ─────────────────────────────────────────────────────────────
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Users can read their own transactions
CREATE POLICY "transactions_select_own"
  ON public.transactions FOR SELECT
  USING (user_id = auth.uid());

-- Users cannot directly insert/update/delete — handled by backend (service role)
