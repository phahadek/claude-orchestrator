# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# Install native build tools required for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

RUN npm ci

# Copy source files
COPY packages/ ./packages/

# Build frontend (outputs to packages/backend/dist/public via vite.config.ts)
RUN npm run build -w packages/frontend

# Build backend TypeScript (outputs to packages/backend/dist)
RUN npm run build -w packages/backend

# ── Stage 2: Production ────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy compiled node_modules (includes native better-sqlite3 binaries built above)
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled backend + bundled frontend
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist

# Copy root package.json (needed for npm workspace resolution at runtime)
COPY package.json ./

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "packages/backend/dist/server.js"]
