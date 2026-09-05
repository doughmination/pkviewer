# pkviewer

Websites for [PluralKit](https://pluralkit.me) systems.

PluralKit holds the identity and the data. pkviewer handles how that identity is
presented on the web: every system gets a public page, every member can have one,
and systems that sign in can choose a readable address and customise how their
pages look.

**pkviewer is a third-party project. It is not PluralKit, and is not affiliated
with or endorsed by the PluralKit project.** It reads PluralKit's public API and
shows only information PluralKit already makes public.

Live at **[pkviewer.xyz](https://pkviewer.xyz)**. The feature set is
deliberately small.

---

## What is in here

```
apps/api        Hono on Bun. Owns SQLite, sessions, the PluralKit client,
                Discord OAuth, and all business logic. The only process that
                opens the database.
apps/web        Next.js on Node. Renders pages and the management UI. Has no
                database driver and no PluralKit client — it reaches the API
                over HTTP.
packages/shared Types, the theme vocabulary, and validation shared by both.
scripts/        Dev runner and the hardcoded-origin guard.
```

The split is deliberate: SQLite permits one writer at a time, and confining all
database access to one long-lived process removes write contention as a category
of bug rather than managing it.

## One origin

Everything a person visits lives on a single user-facing origin:

| Path | |
|---|---|
| `/` | landing page |
| `/login` | Discord sign-in |
| `/auth/...` | OAuth callbacks, proxied to the API by the web tier |
| `/manage/...` | authenticated management UI |
| `/s/...` | public system and member pages |

The API stays internal. The browser never talks to it directly: the web tier
proxies what needs proxying, which is what keeps `INTERNAL_API_ORIGIN` internal.

The session cookie keeps the `__Host-` prefix. It no longer separates two
pkviewer hosts, but it still forbids a `Domain` attribute — so the cookie is
pinned to exactly this host and no sibling subdomain can set or overwrite it.

In development the origin is `http://system.localhost:3000`, which Chrome and
Firefox resolve to 127.0.0.1 with no setup. **Safari does not resolve
`*.localhost`**; add an `/etc/hosts` entry if you use it.

## Prerequisites

- [Bun](https://bun.sh) 1.4 or newer — runs the API, the tests, and the tooling
- Node 20 or newer — Next.js runs on Node, not Bun
- No database server. SQLite is a file.

## Getting started

```bash
bun install
cp .env.example .env      # then read the comments in it
bun run dev
```

That is the supported entry point. It starts both tiers with prefixed output and
shuts both down together, and prints the URLs:

```
site   http://system.localhost:3000   /, /login, /manage, /s/...
api    http://127.0.0.1:3001/health
```

Migrations run automatically on API start, so a fresh checkout needs no bootstrap
step.

> **The API's environment comes from the repository root.** `bun run dev` loads
> `.env` from the root and passes it to both tiers. Running the API directly from
> `apps/api` will *not* find it and will fail at startup naming the missing
> variable. Use `bun run dev`.

Signing in needs Discord OAuth credentials; see `.env.example`, which documents
every variable. Everything else — public pages, the whole rendering path — works
without them, and the API says so at startup rather than refusing to run.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Both tiers, prefixed output, shared shutdown |
| `bun test` | Full test suite |
| `bun run typecheck` | All three workspaces |
| `bun run build` | Production build of the web tier. Writes to `.next-prod`, so it is safe to run while `bun run dev` is up. |
| `bun run migrate` | Apply migrations without starting the server |
| `bun run check` | Origin guard, typecheck and tests — run before pushing |
| `bun run check:domain` | Fails if a deployment hostname is hardcoded |

## Local test data

Claiming a system needs Discord OAuth. To poke at the management UI without it,
seed a local account and session:

```bash
bun scripts/seed-dev.ts <system-id>     # any publicly visible PluralKit system
```

It prints a session token and the cookie line to paste into the browser console.
The seed **reads the system's identifiers from PluralKit** rather than inventing
them, so a seeded row satisfies the same invariant a real claim does. It uses a
fabricated Discord id, so it never ties local data to a real account.

It is a development script and refuses to run when `NODE_ENV=production`.

## Testing

```bash
bun test                       # everything
bun test apps/api/test/slugs   # one file
```

Tests use in-memory SQLite and a stubbed PluralKit, so they need no network and
no local database.

## Running with Docker

```bash
cp .env.example .env      # fill in real values
docker compose pull && docker compose up -d
```

Two containers: `api` (Bun, owns SQLite) and `web` (Node, renders and proxies).
The API port is never published — only the web tier is reachable, so put a TLS
proxy or a tunnel in front. `docker-compose.yml` is commented with the reasoning
for each choice.

## Documentation

**User-facing documentation is a separate site and is not served by this
application:** [docs.doughmination.gay](https://docs.doughmination.gay/projects/pkviewer).
It also carries the support links — Discord, Matrix, and the repository.

The reasoning for anything structural lives in the code, next to what it
constrains: the migrations explain the schema, `docker-compose.yml` explains the
deployment shape, and the tests state the invariant each one guards. Start with
the file you are changing.

## Third-party notices

pkviewer reads the public [PluralKit API](https://pluralkit.me/api/) and sends a
consistent `User-Agent` identifying itself, as PluralKit asks. It never asks for
a PluralKit token in order to claim a system.

Built with [Hono](https://hono.dev), [Next.js](https://nextjs.org),
[React](https://react.dev), [Bun](https://bun.sh), [Zod](https://zod.dev) and
[Bootstrap Icons](https://icons.getbootstrap.com) via
[react-bootstrap-icons](https://github.com/ricardo-ch/react-bootstrap-icons).
Fonts are served from [Google Fonts](https://fonts.google.com).

## Licence

[MIT](LICENSE). © 2026 Clove Twilight.

The licence covers this source code. It does not grant any rights in the
pkviewer name, and it changes nothing about the relationship with PluralKit:
pkviewer is an independent third-party project, not affiliated with or endorsed
by PluralKit, and anything you build from this source is too.
