# Migration archive

SQL of the 36 migrations applied to production between 2026-03-04 and
2026-09-03, exported from `supabase_migrations.schema_migrations`.

They are **not applied** by `supabase start` / `supabase db push`: the
project adopted tracked migrations on 2026-09-17 with a single baseline
(`migrations/20260917000000_baseline.sql`) that already contains their
effects. Kept for history and code review only.
