# syntax=docker/dockerfile:1

# ---------- Stage 1: install production dependencies ----------
FROM node:24-slim AS deps

WORKDIR /app

# Only copy the manifests so this layer is cached until deps change
COPY package.json package-lock.json ./

# Reproducible install, dev deps (nodemon, vitest) excluded
RUN npm ci --omit=dev

# ---------- Stage 2: minimal runtime image ----------
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PORT=5000

WORKDIR /app

# Pull in the already-installed node_modules, then the source.
# --chown sets ownership at copy time: no extra layer, no slow chown -R.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Never run as root inside the container. The base image ships a "node" user.
USER node

EXPOSE 5000

# /api/health does a SELECT 1 against Postgres, so an unreachable DB marks
# the container unhealthy. Uses Node's built-in fetch: no curl/wget needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
