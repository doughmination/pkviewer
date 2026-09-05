# The web tier: Next.js. Renders, and proxies to the API.
#
# Built from the repository root: `docker build -f docker/web.Dockerfile .`
#
# Built with Bun — the project's own toolchain, and already how `bun run build`
# works locally — then run on Node, which is what Next's standalone server
# expects. That avoids installing Bun through npm in two separate stages, which
# cost about 70 seconds of every build.

FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Frozen: a production image installs exactly what was tested, rather than
# resolving fresh versions at build time. Drop `--frozen-lockfile` only if the
# lockfile is genuinely out of date, and then commit the updated one.
RUN bun install --frozen-lockfile

FROM oven/bun:1.2-alpine AS build
WORKDIR /app
# The whole installed tree — see the note in api.Dockerfile about why individual
# node_modules paths are not safe to name.
COPY --from=deps /app ./
COPY . .

# Origins are NOT baked in. Every page that embeds one is force-dynamic and
# reads configuration at request time, so the build runs with placeholders and
# the running container is given the real values. That is what keeps moving
# domains a config change rather than a rebuild.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_DIST_DIR=.next \
    PUBLIC_ORIGIN=http://build.invalid \
    INTERNAL_API_ORIGIN=http://build.invalid

WORKDIR /app/apps/web
RUN bun run next build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S pkviewer && adduser -S -G pkviewer pkviewer

# Standalone output carries only the modules the server actually needs, so the
# runtime image contains neither the monorepo nor its node_modules. Its layout
# is rooted at the workspace, so the entrypoint is apps/web/server.js.
COPY --from=build --chown=pkviewer:pkviewer /app/apps/web/.next/standalone ./
COPY --from=build --chown=pkviewer:pkviewer /app/apps/web/.next/static ./apps/web/.next/static

# There is deliberately no `public` directory in this project, and COPYing a
# path that does not exist fails the build.

USER pkviewer

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
