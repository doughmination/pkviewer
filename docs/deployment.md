# Deploying pkviewer

## Shape

Two processes on one machine, behind a reverse proxy that terminates TLS:

```
            ┌──────────────────────────────┐
 public ────┤  proxy                       │
 app    ────┤  routes both hostnames        │
            └──────────────┬───────────────┘
                           │
                    apps/web  (Node)      :3000
                           │  localhost HTTP
                    apps/api  (Bun)       :3001
                           │
                    SQLite file on a persistent disk
```

Both hostnames point at the same Next process; middleware decides which routes
each may answer, from the `Host` header.

**This cannot run on a serverless platform.** SQLite needs a persistent disk and
a single long-lived writer. A small VPS, or a container with a real volume.

Only the web tier should be reachable from the internet. The API listens on
localhost and is not exposed.

## Environment variables

`.env` lives at the repository root and is read by both tiers.

Legend: **required** = the process refuses to start without it ·
**production** = additionally required when `NODE_ENV=production` ·
*secret* = never commit, never log, never send to the browser.

### Origins — required

| Variable | Consumed by | Notes |
|---|---|---|
| `PUBLIC_APP_ORIGIN` | api, web | Session-bearing origin. `/login`, `/auth`, `/manage`. Must be https in production. |
| `PUBLIC_USERCONTENT_ORIGIN` | api, web | Public, shareable origin. `/` and `/s/...`. **Must differ from the app origin in every environment, including development** — the process refuses to start otherwise. |
| `PUBLIC_ASSET_ORIGIN` | api | May equal the public origin. |
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
| `DISCORD_REDIRECT_URIS` | **production** | Comma-separated. **Register the beta and production URIs together** so the domain move is a cutover, not a flag day. Each must be `<app origin>/auth/discord/callback` and registered identically in Discord. |

Without Discord credentials the app still runs and every public page works —
nobody can sign in. That is a legitimate read-only deployment.

### Database

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_PATH` | optional | Default `./data/pkviewer.db`. **Relative paths resolve against the API process's working directory**, which is `apps/api` under `bun run dev` — so the dev database is at `apps/api/data/pkviewer.db`. **Use an absolute path in production.** |

### Beta flags

| Variable | Default | Notes |
|---|---|---|
| `BETA_MODE` | `false` | When true: `noindex` on everything, and claiming is limited to the allow-list. |
| `SIGNUP_ENABLED` | `false` | Gates creating a **new** account only. Turning it off never locks existing testers out. |
| `BETA_ALLOWED_DISCORD_IDS` | empty | Comma-separated Discord user IDs permitted to claim a system while in beta. **Empty means nobody can claim.** |
| `API_PORT` | `3001` | |
| `NODE_ENV` | `development` | `production` turns on the stricter checks above. |

### Minimum production set

```
NODE_ENV=production
PUBLIC_APP_ORIGIN=https://app.example
PUBLIC_USERCONTENT_ORIGIN=https://public.example
PUBLIC_ASSET_ORIGIN=https://public.example
INTERNAL_API_ORIGIN=http://127.0.0.1:3001
DATABASE_PATH=/var/lib/pkviewer/pkviewer.db
PK_USER_AGENT_CONTACT=https://github.com/OWNER/pkviewer
PUBLIC_DOCS_URL=https://docs.example
SESSION_SECRET=<openssl rand -base64 32>
DISCORD_CLIENT_ID=<from Discord>
DISCORD_CLIENT_SECRET=<from Discord>
DISCORD_REDIRECT_URIS=https://app.example/auth/discord/callback
BETA_MODE=true
SIGNUP_ENABLED=true
BETA_ALLOWED_DISCORD_IDS=<your Discord user id>
```

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

## Deploying a change

```bash
bun install
bun run check          # guard, typecheck, tests
bun run build
# restart both processes; migrations run on API start
```

Migrations are forward-only. Test them against a copy of production data before
deploying a schema change.

The production build writes to `.next-prod` and the dev server uses `.next`, so
building never disturbs a running development server. `NEXT_DIST_DIR` overrides
the directory if a deployment needs it elsewhere.

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
