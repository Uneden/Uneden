# Uneden

[![Unit Tests](https://github.com/Uneden/Uneden/actions/workflows/test.yml/badge.svg)](https://github.com/Uneden/Uneden/actions/workflows/test.yml)
[![E2E Tests](https://github.com/Uneden/Uneden/actions/workflows/e2e.yml/badge.svg)](https://github.com/Uneden/Uneden/actions/workflows/e2e.yml)
[![Docker Images](https://github.com/Uneden/Uneden/actions/workflows/docker.yml/badge.svg)](https://github.com/Uneden/Uneden/actions/workflows/docker.yml)
[![CodeQL](https://github.com/Uneden/Uneden/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/Uneden/Uneden/security/code-scanning)

Marketplace connecting people who need a service with local workers: listings, booking requests with price negotiation, in-app messaging, Stripe payments (Connect payouts, deposits, refunds) and a dispute flow. Bilingual FR/EN. Live at [uneden.ca](https://www.uneden.ca).

## Architecture

```text
 Browser ──────────────┬──────────────► Supabase Auth  (sign-in, sessions, JWT)
   │                   │
   │  Next.js 16       │  Bearer JWT
   ▼                   ▼
 Vercel            Express API (Render) ──► Postgres (Supabase)
                       │                 ──► Supabase Storage (images, attachments)
                       ├──► Stripe (checkout, Connect, webhooks)
                       ├──► Resend / SMTP (transactional email)
                       └──► Web Push
```

- The browser authenticates directly with Supabase Auth; every API call carries the resulting JWT, which the API verifies locally (HS256 shared secret, or ES256 via the project's JWKS once signing keys are rotated).
- All data access goes through the API with the service-role key. Tables have RLS enabled and no client-side policies, so the anon key alone cannot read anything.
- Supabase Realtime is used client-side for chat and booking updates.

| Layer | Tech | Hosted on |
| --- | --- | --- |
| `frontend/` | Next.js 16 (App Router, React 19, TypeScript, Tailwind, shadcn/ui, i18next) | Vercel |
| `backend/` | Node 24, Express 5, `pg`, Stripe, Nodemailer/Resend, web-push, node-cron | Render |
| `supabase/` | Postgres 17, Auth, Storage, Realtime | Supabase |
| `dashboard/` | Admin console CLI (Node) | local |
| Observability | Sentry (frontend + backend), Supabase advisors | — |

## Run locally

### Option A — Docker (recommended)

Requires [Docker Desktop](https://docs.docker.com/desktop/).

```bash
cp backend/.env.example backend/.env          # fill in
cp frontend/.env.example frontend/.env.local  # fill in
docker compose up --build
```

- Frontend → <http://localhost:3000>
- Backend → <http://localhost:5000> (health: `/api/health`)

`docker compose down` stops everything. The frontend container waits for the backend health check before starting.

### Option A′ — Docker + local Supabase (isolated database)

Same as above, but against a throwaway Supabase running on your machine (Postgres, Auth, Storage, Studio) built from [`supabase/migrations/`](supabase/migrations/) and [`supabase/seed.sql`](supabase/seed.sql). No production data is touched: ideal for testing payments, sign-ups or destructive changes.

```bash
npx supabase start                 # first run downloads ~1.5 GB of images
sh scripts/make-local-env.sh       # frontend/.env.local → .env.supabase-local (local URL/key)
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

- Studio (DB browser) → <http://localhost:54323>
- Mailpit (catches every email the app sends) → <http://localhost:54324>
- Seeded accounts: `seller@test.local` / `Test-seller-1234` and `buyer@test.local` / `Test-buyer-1234`
- `npx supabase stop` shuts the stack down; `npx supabase db reset` rebuilds it from the migrations + seed.

### Option B — Node

Requires Node 24.

```bash
# terminal 1
cd backend && npm ci && npm run dev      # nodemon on :5000

# terminal 2
cd frontend && npm ci && npm run dev     # next dev on :3000
```

## Environment variables

Templates with every key and a short comment:

- [`backend/.env.example`](backend/.env.example)
- [`frontend/.env.example`](frontend/.env.example)
- [`frontend/.env.test.example`](frontend/.env.test.example) — Playwright fixtures, matching the seed

`.env` files are git-ignored and never copied into Docker images: the backend reads them at runtime, the frontend build mounts them as a BuildKit secret (see [`frontend/Dockerfile`](frontend/Dockerfile)).

## Database

The schema is versioned in `supabase/migrations/`. The project adopted tracked migrations on 2026-09-17 with a single **baseline** dumped from production (39 tables, 55 RLS policies, functions, triggers, storage buckets); the SQL of the 36 migrations applied before that date is kept in `supabase/migrations_archive/` for history only.

To change the schema:

```bash
npx supabase migration new add_something   # creates supabase/migrations/<timestamp>_add_something.sql
npx supabase db reset                      # rebuilds the local DB from baseline + your migration + seed
```

Apply to production from the Supabase dashboard (SQL editor) or `supabase db push` once the project is linked.

## Tests

```bash
cd backend  && npm run test:unit   # Vitest — API helpers, security rules
cd frontend && npm run test:unit   # Vitest — components, hooks, utils
cd frontend && npm run lint        # ESLint (next/core-web-vitals + TS)
cd frontend && npx playwright test # E2E (Chromium, fr-CA) against a running app
#   against local Supabase: cp .env.test.example .env.test (matches supabase/seed.sql)
```

The E2E suite covers sign-in, registration, listings, posting, bookings, favorites, messages, profile, wallet and support. `flow-transaction.spec.ts` drives a real Stripe checkout and is only run manually with test-mode keys.

## CI / CD

Everything runs on GitHub Actions on every push and pull request to `main`:

| Workflow | What it does |
| --- | --- |
| [`test.yml`](.github/workflows/test.yml) | Vitest (backend, frontend) + ESLint |
| [`e2e.yml`](.github/workflows/e2e.yml) | Playwright end-to-end: starts a local Supabase in the runner (migrations + seed), the backend and a production build of the frontend, runs the suite; HTML report + server logs uploaded as an artifact |
| [`docker.yml`](.github/workflows/docker.yml) | Builds both images with layer caching; on `main`, pushes `ghcr.io/uneden/uneden-backend` and `ghcr.io/uneden/uneden-frontend` tagged `latest` + commit SHA |
| CodeQL / Dependabot | Static analysis and dependency updates (GitHub-managed) |

Deploys are handled by the hosting platforms on push to `main` (Vercel for the frontend, Render for the backend).

## Docker images

Both images are multi-stage, run as the unprivileged `node` user, and expose a `HEALTHCHECK`:

- **backend** — `node:24-slim`, production deps only (`npm ci --omit=dev`), ~480 MB. Health check hits `/api/health`, which runs `SELECT 1` against Postgres.
- **frontend** — `next build` with `output: "standalone"` (enabled only when `NEXT_OUTPUT_STANDALONE=1`, so the Vercel build is untouched), ~450 MB. `NEXT_IMAGES_UNOPTIMIZED=1` skips the image optimizer for test builds.

## Project layout

```text
.
├── backend/                  Express API
│   ├── src/                  controllers, routes, services, jobs, middleware, lib
│   ├── tests/                Vitest + security checks
│   └── Dockerfile
├── frontend/                 Next.js app
│   ├── src/app/              App Router pages
│   ├── src/components/
│   ├── tests/                Playwright E2E
│   └── Dockerfile
├── supabase/
│   ├── config.toml           local stack configuration
│   ├── migrations/           baseline schema
│   ├── migrations_archive/   pre-baseline history (reference only)
│   └── seed.sql              local/CI fixtures
├── dashboard/                admin CLI
├── scripts/                  dev helpers
├── docker-compose.yml        backend + frontend
├── docker-compose.local.yml  override: point the stack at local Supabase
└── .github/workflows/        CI
```
