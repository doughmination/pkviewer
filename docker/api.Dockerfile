# The API tier: Hono on Bun, and the only process that opens SQLite.
#
# Built from the repository root, because it depends on the shared workspace
# package: `docker build -f docker/api.Dockerfile .`

# Bun must match the version that wrote bun.lock.
#
# This was pinned to 1.2 while the lockfile came from 1.4, and a frozen install
# cannot satisfy a lockfile from a newer Bun — the build failed on the server
# while working locally. Keep this in step with the Bun you develop and test
# with; a test asserts they match.
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
# Manifests first, so a source-only change does not reinstall dependencies.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Frozen: a production image installs exactly what was tested, rather than
# resolving fresh versions at build time. Drop `--frozen-lockfile` only if the
# lockfile is genuinely out of date, and then commit the updated one.
RUN bun install --frozen-lockfile

FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

# A non-root user owning the data directory the volume mounts onto.
RUN addgroup -S pkviewer && adduser -S -G pkviewer pkviewer \
    && mkdir -p /data && chown pkviewer:pkviewer /data

# The WHOLE installed tree, not individual node_modules paths.
#
# Bun decides where to place workspace dependencies, and that decision depends
# on what else is present: with only manifests copied it hoists everything to
# the root, so `apps/api/node_modules` may not exist at all. Copying the tree
# works whatever it chose.
COPY --from=deps /app ./

# Source overlays the install. `.dockerignore` excludes node_modules, so these
# add files without disturbing what was installed above.
COPY package.json bun.lock ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

USER pkviewer

ENV NODE_ENV=production \
    DATABASE_PATH=/data/pkviewer.db \
    API_PORT=3001 \
    API_HOST=0.0.0.0

# Exposed to the compose network only, never published to the host. That
# boundary is what replaces the loopback bind: the API stays unreachable from
# outside, which the architecture requires.
EXPOSE 3001

WORKDIR /app/apps/api

# Migrations run at startup, inside the one process that owns the database.
CMD ["bun", "run", "src/index.ts"]
