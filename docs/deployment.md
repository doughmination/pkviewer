# Deploying pkviewer

## Shape

Two processes on one machine, behind a reverse proxy that terminates TLS:

```
            ┌──────────────────────────────┐
 users  ────┤  proxy (TLS)                 │
            └──────────────┬───────────────┘
                           │
                    apps/web  (Node)      :3000
                           │  localhost HTTP
                    apps/api  (Bun)       :3001
                           │
                    SQLite file on a persistent disk
```

One hostname, one Next process. There is no origin-based routing: every route
is served from the same origin.

**This cannot run on a serverless platform.** SQLite needs a persistent disk and
a single long-lived writer. A small VPS, or a container with a real volume.

Only the web tier is reachable from outside. The API binds loopback by default
(`API_HOST`, default `127.0.0.1`) — the browser never calls it, and the web tier
proxies everything. In containers it binds `0.0.0.0` because the container
network provides the isolation instead, and its port is never published.

## Environment variables

`.env` lives at the repository root and is read by both tiers.

Legend: **required** = the process refuses to start without it ·
**production** = additionally required when `NODE_ENV=production` ·
*secret* = never commit, never log, never send to the browser.

### Origins — required

| Variable | Consumed by | Notes |
|---|---|---|
| `PUBLIC_ORIGIN` | api, web | **The one user-facing origin.** Serves `/`, `/login`, `/auth/...`, `/manage/...` and `/s/...`. Must be https in production. |
| `PUBLIC_ASSET_ORIGIN` | api | *Optional.* Defaults to `PUBLIC_ORIGIN`. Reserved for serving media elsewhere. |
| `INTERNAL_API_ORIGIN` | web | Where the web tier reaches the API. Internal; never reaches the browser. |
| `PUBLIC_DOCS_URL` | web | *Optional.* The separate documentation site. Empty hides every documentation link rather than producing a dead one. |

These are read at **runtime**, not baked into the build. A domain move is a
config change plus a restart, not a rebuild — every page that embeds an origin
is `force-dynamic` specifically to keep that true.

### PluralKit — one required

| Variable | Required | Notes |
|---|---|---|
| `PK_USER_AGENT_CONTACT` | **required** | URL placed in the `User-Agent`. **Point it at the repository, not the deployment origin**, so it survives a domain move. PluralKit asks that an application's UA be stable and identifiable. |
| `PK_API_BASE` | optional | Defaults to `https://api.pluralkit.me/v2`. |
| `PK_RATE_LIMIT_READ_RPS` | optional | Default 6, deliberately under PluralKit's documented 10/s. |
| `PK_RATE_LIMIT_WRITE_RPS` | optional | Default 2, under their 3/s. |

### Sessions and Discord

| Variable | Required | Notes |
|---|---|---|
| `SESSION_SECRET` *secret* | **production** | ≥32 chars. `openssl rand -base64 32`. Outside production an ephemeral one is generated per start, with a warning. |
| `DISCORD_CLIENT_ID` | **production** | From the Discord developer portal. |
| `DISCORD_CLIENT_SECRET` *secret* | **production** | Same. |
| `DISCORD_REDIRECT_URIS` | **production** | Comma-separated. **Register both the old and new URIs together** before a domain move, so it is a cutover rather than a flag day. Each must be `<public origin>/auth/discord/callback` and registered identically in Discord. |

Without Discord credentials the app still runs and every public page works —
nobody can sign in, and `/auth/discord/start` answers 503. That is a legitimate
read-only deployment, and startup says so rather than refusing to boot.

`PUBLIC_ORIGIN` must still be https in production even before a certificate
exists: it is the public URL visitors will use, TLS terminates at the proxy in
front, and the container itself speaks http behind it. Session cookies are
`Secure`, so sign-in cannot work over http.

### Database

| Variable | Required | Notes |
|---|---|---|
| `API_HOST` | optional | Interface the API binds to. Default `127.0.0.1`. Set `0.0.0.0` only where something else isolates it, such as a container network with an unpublished port. |
| `API_PORT` | optional | Default `3001`. |
| `DATABASE_PATH` | optional | Default `./data/pkviewer.db`. **Relative paths resolve against the API process's working directory**, which is `apps/api` under `bun run dev` — so the dev database is at `apps/api/data/pkviewer.db`. **Use an absolute path in production.** |

### Other flags

| Variable | Default | Notes |
|---|---|---|
| `SIGNUP_ENABLED` | `true` | Gates creating a **new** account only. Turning it off never locks an existing account out of what it already has. |
| `API_PORT` | `3001` | |
| `NODE_ENV` | `development` | `production` turns on the stricter checks above. |

pkviewer is no longer in beta. `BETA_MODE` and `BETA_ALLOWED_DISCORD_IDS` are
gone rather than defaulted off — setting them now does nothing. Claiming is open
to any signed-in account, gated by proving control of the system rather than by
membership of a list, and public pages are indexable.

### Minimum production set

```
NODE_ENV=production
PUBLIC_ORIGIN=https://system.example
INTERNAL_API_ORIGIN=http://127.0.0.1:3001
DATABASE_PATH=/var/lib/pkviewer/pkviewer.db
PK_USER_AGENT_CONTACT=https://github.com/OWNER/pkviewer
PUBLIC_DOCS_URL=https://docs.example
SESSION_SECRET=<openssl rand -base64 32>
DISCORD_CLIENT_ID=<from Discord>
DISCORD_CLIENT_SECRET=<from Discord>
DISCORD_REDIRECT_URIS=https://system.example/auth/discord/callback
SIGNUP_ENABLED=true
```

Under Docker, `INTERNAL_API_ORIGIN` and `DATABASE_PATH` are set by compose
(`http://api:3001` and `/data/pkviewer.db`) rather than by `.env`.

Configuration is validated at startup and a missing or malformed value fails
loudly, naming the variable. It never falls back to an insecure default in
production.

## Database

One SQLite file, in WAL mode. Migrations apply automatically at API start, in
filename order, each in its own transaction; already-applied ones are skipped.

Schema changes are additive: **add a new migration, never edit an applied one.**

### What to back up

| | |
|---|---|
| `DATABASE_PATH` | The database. Everything pkviewer owns. |
| `<path>-wal`, `<path>-shm` | Sidecars. Present while running; a copy without them can be inconsistent. |
| `.env` | Secrets. **Back up separately from the database, not alongside it.** |

**Never `cp` a live database.** WAL means a plain copy can be torn. Take a
consistent snapshot while running with:

```bash
sqlite3 /var/lib/pkviewer/pkviewer.db ".backup '/backups/pkviewer-$(date +%F).db'"
```

or `VACUUM INTO`. Both are safe against a running server. For continuous
protection, [Litestream](https://litestream.io) replicates WAL to object storage
and preserves the "it's just a file" model — the highest-value addition when this
carries other people's data.

### If the database is lost

PluralKit data is not lost — it is PluralKit's, and re-fetches. What is lost is
everything pkviewer owns: accounts and their Discord links, which systems are
claimed and by whom, chosen addresses and their reservations, themes, layout
settings, and social links.

Public pages would keep working for systems reachable by PluralKit ID; chosen
addresses would stop resolving and would become claimable by anyone. Claiming
would have to be redone. **Treat the database as the thing that actually needs
backing up.**

## Running with Docker

`docker-compose.yml` runs images; it never builds them. Images are built and
published by `.github/workflows/images.yml`, so what runs on the server is
always something CI produced from a known commit — the server needs no
toolchain, no source checkout and no spare CPU, and there is no question of
which working copy the running code came from.

Which images run is not configurable: `docker-compose.yml` names
`doughmination/pkviewer-api:latest` and `doughmination/pkviewer-web:latest`
outright. On the server, that file and `.env` are all that is needed:

```bash
cp .env.example .env      # fill in the production values
docker compose pull
docker compose up -d
```

Two containers, mirroring the architecture: `api` owns SQLite and is the only
writer; `web` renders and proxies. Configuration comes from `.env` at run time —
nothing secret is baked into an image, and no origin is compiled in, so moving
domains stays a config change.

Four details in `docker-compose.yml` are deliberate:

- **`api` has no `ports:`, only `expose:`.** Publishing 3001 would put the
  management API straight onto the host network, reachable without going through
  the web tier. It is addressable only as `http://api:3001` from inside.
- **`web` publishes `3000:3000`, on every interface.** A loopback-only bind is
  unreachable from another container or another machine, which is what
  Cloudflare Tunnel needs. TLS terminates at Cloudflare; the container is never
  the thing facing the internet. See below.
- **`pull_policy: always`.** A pinned tag is only a pin if a restart actually
  fetches it rather than reusing whatever is in the local image cache.
- **The named volume `pkviewer-data` is the whole of pkviewer's state.** Back
  that up; see below.

Backups work the same way, run against the container:

```bash
docker compose exec api sh -c \
  "bun -e 'new (require(\"bun:sqlite\").Database)(\"/data/pkviewer.db\").exec(\"VACUUM INTO \\\"/data/backup.db\\\"\")'"
```

or more simply, stop the stack and copy the volume. Never `cp` a live WAL
database.

### Getting traffic in: Cloudflare Tunnel

The reference deployment has no public IP. `cloudflared` dials out to
Cloudflare, which terminates TLS and forwards to the container, so nothing is
inbound-reachable and no ports need opening at the network edge.

Point the tunnel at `http://<host-lan-ip>:3000` — or `http://web:3000` if
`cloudflared` runs as a container on the same compose network, which avoids
publishing the port at all. `3000:3000` rather than `127.0.0.1:3000:3000` is
what makes the first form work: a loopback bind is not reachable from another
container or another machine.

**Plain http on that hop is fine.** The browser talks https to Cloudflare, and
`Secure` is set unconditionally rather than inferred from the request
(`apps/api/src/http/cookies.ts`), so no forwarded-proto trust needs configuring.
`PUBLIC_ORIGIN` must still be the https URL: it is what the CSRF check compares
the `Origin` header against, and what every absolute link is built from.

One thing to be aware of if this ever runs on a host that *does* have a public
IP: Docker publishes through the `DOCKER-USER` chain and `nat PREROUTING`, which
run **before** the `INPUT` chain `ufw` and `firewalld` manage, so `ufw deny 3000`
does nothing. Restricting it then means a security group, or
`iptables -I DOCKER-USER -p tcp --dport 3000 ! -s <source> -j DROP`.

## Administrators

Admin is a grant row, not an environment variable. `ADMIN_*` does not exist, and
neither does an HTTP route that creates the first one — there would be nobody to
authorise it, and a variable would silently re-promote whoever held that Discord
id on every restart, with no record of when or by whom.

```bash
bun run admin:list
bun run admin:grant <discord-user-id>
bun run admin:revoke <discord-user-id>
```

Run from the repository root, so `.env` is picked up. Under Docker:

```bash
docker compose exec api bun run scripts/admin.ts list
```

The account must exist first: sign in with that Discord account once, then grant
it. Only the database path is read, so this still works when Discord
credentials are missing — which is when you are most likely to need it.

**What an admin can do** is grant badges and edit the credits page. **What an
admin cannot do** is touch anyone's system, theme, address or links: system
access is a grant whose subject is that system, and a platform grant can never
satisfy that lookup. The database refuses to store `admin` over a system at all
(migration 005), so this is a schema constraint rather than a convention.

## Publishing images

`.github/workflows/images.yml` builds both images for amd64 and arm64 on every
push to `main` and publishes them to Docker Hub.

It needs one repository secret, under Settings → Secrets and variables →
Actions: **`DOCKERHUB_TOKEN`**, a personal access token with Read & Write scope,
from Docker Hub → Account settings → Personal access tokens.

Use an access token, never the account password: a token is scoped, listed, and
revocable on its own without changing the password everywhere else it is used.
The account name is not a secret — it is half of every published image name —
so it sits in the workflow as `DOCKERHUB_USER`.

The two repositories — `doughmination/pkviewer-api` and
`doughmination/pkviewer-web` — are created by the first successful push. They
are public by default; make them private in Docker Hub if that is wanted, and
then `docker login` on the server before pulling.

**The images pin Bun to the version that wrote `bun.lock`.** A frozen install
cannot satisfy a lockfile written by a newer Bun, so an image pinned behind the
lockfile fails while building fine locally. When you upgrade Bun, update
`docker/*.Dockerfile` in the same commit — a test asserts they match.

To build an image by hand, from the repository root:

```bash
docker build -f docker/api.Dockerfile .
docker build -f docker/web.Dockerfile .
```

### Tags

Every build is published under several tags:

| Tag | Moves | Notes |
| --- | --- | --- |
| `latest` | yes, on every push to `main` | what compose runs |
| `sha-abc1234` | never | the exact commit |
| `1.2.3` | never | a release, from a `v1.2.3` git tag |
| `1.2` | yes, within a minor series | a patch series |

Compose runs `latest` and nothing else, so a `docker compose pull` is the whole
upgrade and there is no version to keep in step between the repository and the
server. The cost is that a bad `main` reaches the server on the next pull, and
that the running version is not recorded anywhere.

To go back, pull an older tag under the `latest` name by hand:

```bash
docker pull doughmination/pkviewer-api:sha-abc1234
docker tag doughmination/pkviewer-api:sha-abc1234 doughmination/pkviewer-api:latest
docker compose up -d --no-deps api      # without `pull`, which would undo it
```

That holds until the next `docker compose pull`, so it buys time to fix `main`
rather than being a place to sit.

### Deploying a new image

```bash
docker compose pull
docker compose up -d
```

Nothing to edit: CI publishes `latest`, `pull` fetches it, `up -d` recreates
whichever containers changed.

Migrations run on API start, inside the one process that owns the database, and
are forward-only. Test them against a copy of production data before deploying a
schema change — retagging an older image does not roll a migration back.

## Working locally

Deployment goes through images, but the checks that gate one still run here:

```bash
bun install
bun run check          # guard, typecheck, tests
bun run build
```

The production build writes to `.next-prod` and the dev server uses `.next`, so
building never disturbs a running development server. `NEXT_DIST_DIR` overrides
the directory if a deployment needs it elsewhere.

Running the two processes directly — `bun run dev` — needs the same environment
variables as the containers, minus the image ones. `API_HOST` defaults to
`127.0.0.1` outside Docker; the images set it to `0.0.0.0` so the web container
can reach the API over the compose network.

## Moving domains

Under the rules above this is configuration, with two things that are not free:

1. **Sessions end.** Cookies are host-scoped; everyone signs in again.
2. **PluralKit dispatch webhooks break silently** if that integration is ever
   enabled — the URL lives on PluralKit's side. Keep the old host answering
   `/dispatch` through the transition; do not rely on a redirect.

Register both redirect URIs in Discord before the move, and keep the old host
redirecting for a long while.

## Security posture

Set by the web tier, since the browser never talks to the API directly:
`Content-Security-Policy` (including `frame-ancestors 'none'`),
`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy`, and `Strict-Transport-Security`
in production.

Two deliberate CSP exceptions, both documented in `apps/web/next.config.ts`:
`script-src` allows `'unsafe-inline'` because Next bootstraps through inline
scripts and tightening it needs per-request nonces; `img-src` allows any https
host because avatars and banners live wherever each system put them. Neither is
load-bearing for XSS, because pkviewer accepts no user HTML, no user JavaScript
and no free-form CSS.

TLS is terminated at the proxy. Cookies are `Secure` and `__Host-` prefixed, so
**the app must be served over https in production or sign-in will not work.**
