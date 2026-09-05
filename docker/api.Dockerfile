# The API tier: Hono on Bun, and the only process that opens SQLite.
#
# Built from the repository root, because it depends on the shared workspace
# package: `docker build -f docker/api.Dockerfile .`

FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
# Manifests first, so a source-only change does not reinstall dependencies.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM oven/bun:1.2-alpine AS runtime
WORKDIR /app

# A non-root user owning the data directory the volume mounts onto.
RUN addgroup -S pkviewer && adduser -S -G pkviewer pkviewer \
    && mkdir -p /data && chown pkviewer:pkviewer /data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json bun.lock ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

USER pkviewer

ENV NODE_ENV=production \
    DATABASE_PATH=/data/pkviewer.db \
    API_PORT=3001 \
    API_HOST=0.0.0.0

# The port is exposed to the compose network only and never published to the
# host. That network boundary is what replaces the loopback bind: the API stays
# unreachable from outside, which the architecture requires.
EXPOSE 3001

WORKDIR /app/apps/api

# Migrations run at startup, inside the one process that owns the database.
CMD ["bun", "run", "src/index.ts"]
