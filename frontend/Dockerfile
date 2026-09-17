# syntax=docker/dockerfile:1

# ---------- Stage 1: install all dependencies (build needs dev deps) ----------
FROM node:24-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- Stage 2: build the Next.js app ----------
FROM node:24-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 1 = build without image optimisation (test builds only, see docker-compose.local.yml)
ARG NEXT_IMAGES_UNOPTIMIZED=0

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT_STANDALONE=1 \
    NEXT_IMAGES_UNOPTIMIZED=$NEXT_IMAGES_UNOPTIMIZED \
    # Empty token = Sentry plugin skips source-map upload for local images
    SENTRY_AUTH_TOKEN=""

# NEXT_PUBLIC_* values are inlined into the bundle at build time, so the build
# needs the env file. It is mounted as a BuildKit secret: readable during this
# RUN only, never written to an image layer.
RUN --mount=type=secret,id=frontend_env,target=/app/.env.local \
    npm run build

# ---------- Stage 3: minimal runtime image ----------
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# The standalone output already contains the pruned node_modules + server.js
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
