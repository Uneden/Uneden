#!/usr/bin/env sh
# Generates frontend/.env.supabase-local from frontend/.env.local, pointing
# the browser-side Supabase client at the local stack (npx supabase start).
set -e
cd "$(dirname "$0")/.."
ANON=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
sed -E \
  -e "s#^NEXT_PUBLIC_SUPABASE_URL=.*#NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321#" \
  -e "s#^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*#NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON#" \
  frontend/.env.local > frontend/.env.supabase-local
echo "frontend/.env.supabase-local written"
