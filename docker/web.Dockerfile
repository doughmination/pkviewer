# The web tier: Next.js on Node. Renders, and proxies to the API.
#
# Built from the repository root: `docker build -f docker/web.Dockerfile .`

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && npm i -g bun@1.2 || true
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN npm i -g bun@1.2 || true
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .

# Origins are NOT baked in. Every page that embeds one is force-dynamic and
# reads configuration at request time, so the build runs with placeholders and
# the running container is given the real values. That is what makes moving
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
# runtime image contains neither the monorepo nor its node_modules.
COPY --from=build --chown=pkviewer:pkviewer /app/apps/web/.next/standalone ./
COPY --from=build --chown=pkviewer:pkviewer /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=pkviewer:pkviewer /app/apps/web/public ./apps/web/public

USER pkviewer

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

# Standalone emits a server entrypoint at the traced workspace path.
CMD ["node", "apps/web/server.js"]
