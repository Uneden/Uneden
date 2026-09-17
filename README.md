# Uneden

[![Unit Tests](https://github.com/Uneden/Uneden/actions/workflows/test.yml/badge.svg)](https://github.com/Uneden/Uneden/actions/workflows/test.yml)
[![Docker Images](https://github.com/Uneden/Uneden/actions/workflows/docker.yml/badge.svg)](https://github.com/Uneden/Uneden/actions/workflows/docker.yml)
[![CodeQL](https://github.com/Uneden/Uneden/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/Uneden/Uneden/security/code-scanning)

Marketplace connecting people who need a service with local workers — listings, bookings, in-app messaging, Stripe payments and disputes. Live at [uneden.ca](https://www.uneden.ca).

## Stack

| Layer | Tech | Hosted on |
|---|---|---|
| `frontend/` | Next.js 16 (App Router, React 19, TypeScript, Tailwind, i18next) | Vercel |
| `backend/` | Node 24, Express 5, `pg`, Stripe, Nodemailer/Resend, web-push | Render |
| `supabase/` | Postgres 17, Auth, Storage (Supabase) | Supabase |
| `dashboard/` | Admin console CLI (Node) | local |
| Observability | Sentry (frontend + backend) | — |

The frontend talks to Supabase directly for auth and to the Express API for everything else. The API uses the Supabase service-role key; tables have RLS enabled with no client-side policies, so all data access goes through the API.

## Run locally

### Option A — Docker (recommended)

Requires [Docker Desktop](https://docs.docker.com/desktop/).

```bash
cp backend/.env.example backend/.env          # fill in
cp frontend/.env.example frontend/.env.local  # fill in
docker compose up --build
```

- Frontend → http://localhost:3000
- Backend → http://localhost:5000 (health: `/api/health`)

`docker compose down` stops everything. The frontend container waits for the backend health check before starting.

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

`.env` files are git-ignored and never copied into Docker images: the backend reads them at runtime, the frontend build mounts them as a BuildKit secret (see [`frontend/Dockerfile`](frontend/Dockerfile)).

## Tests

```bash
cd backend  && npm run test:unit   # Vitest
cd frontend && npm run test:unit   # Vitest
cd frontend && npm run lint        # ESLint (next/core-web-vitals + TS)
cd frontend && npx playwright test # E2E — needs a running app + test accounts in frontend/.env.test
```

## CI / CD

Everything runs on GitHub Actions on every push and pull request to `main`:

| Workflow | What it does |
|---|---|
| [`test.yml`](.github/workflows/test.yml) | Vitest (backend, frontend) + ESLint |
| [`docker.yml`](.github/workflows/docker.yml) | Builds both images with layer caching; on `main`, pushes `ghcr.io/uneden/uneden-backend` and `ghcr.io/uneden/uneden-frontend` tagged `latest` + commit SHA |
| CodeQL / Dependabot | Static analysis and dependency updates (GitHub-managed) |

Deploys are handled by the hosting platforms on push to `main` (Vercel for the frontend, Render for the backend).

## Docker images

Both images are multi-stage, run as the unprivileged `node` user, and expose a `HEALTHCHECK`:

- **backend** — `node:24-slim`, production deps only (`npm ci --omit=dev`), ~480 MB. Health check hits `/api/health`, which runs `SELECT 1` against Postgres.
- **frontend** — `next build` with `output: "standalone"` (enabled only when `NEXT_OUTPUT_STANDALONE=1`, so the Vercel build is untouched), ~450 MB.

## Project layout

```
.
├── backend/            Express API
│   ├── src/            controllers, routes, services, jobs, middleware
│   ├── tests/          Vitest + security tests
│   └── Dockerfile
├── frontend/           Next.js app
│   ├── src/app/        App Router pages
│   ├── src/components/
│   ├── tests/          Playwright E2E
│   └── Dockerfile
├── supabase/           database migrations
├── dashboard/          admin CLI
├── docker-compose.yml
└── .github/workflows/  CI
```
