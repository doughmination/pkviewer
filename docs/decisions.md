# pkviewer — decision log

Signed-off decisions. Implementation follows these; changing one is a deliberate
act, not a refactor. Numbering is stable so other documents can cite it.

## Architecture

**A1. Two processes.** Hono on Bun owns everything stateful — database, sessions,
PluralKit client, OAuth, business logic — and is the only process that opens
SQLite, so there is exactly one writer. Next.js on Node renders and reaches the
API over HTTP. **Next.js never imports anything under `apps/api/src/db`.**

**A2. SSR is required**, not decorative: public pages are shared into Discord,
whose unfurler does not run JavaScript. Server-rendered `<meta>` is the point.

**A3. No serverless.** SQLite needs a persistent disk. Single VPS or a volume.

## The twelve

1. **Domain is configuration.** `system.doughmination.gay` is the beta
   deployment. No absolute pkviewer URL is ever persisted to the database; public
   URLs are composed at render time from config. Enforced by
   `scripts/check-no-hardcoded-origin.sh` in CI.
2. **User content gets its own origin**, from day one. See O1 below.
3. **Management lives under `/manage/...`**, never `/s/:system/...`, so a member
   slug can never collide with an app route.
4. **MVP slugs are `[a-z0-9-]` only.** Eliminates homograph squatting outright
   rather than mitigating it. Unicode can come later with confusable folding.
5. **Private members 404**, with nothing distinguishing them from a member that
   never existed. PluralKit's own 404 already behaves this way, and `PkNotFound`
   deliberately does not separate the two cases.
6. **Slug reservation is 7 days and subject-owned** — the reclaim right follows
   the system or member, not the account that held it.
7. **A contested claim is blocked automatically**, with a manual appeal path.
   The legitimate case and the attack case are indistinguishable to us, so there
   is no safe automatic policy.
8. **`/s/<pk-id>` and `/s/<slug>` both return 200**; the slug is canonical via
   `<link rel="canonical">`. Never a 301 for anything slug-based — permanent
   redirects outlive slug ownership.
9. **Member logins are post-MVP**, but `grants(subject_type, subject_id)` already
   models them. Adding member principals needs rows, not a migration.
10. **PluralKit Dispatch is opt-in**, never required for claiming. A system has
    only one webhook URL, so enabling ours overwrites any other integration —
    this must be stated plainly in the UI.
11. **Unclaiming**: 7-day slug reservation, 30-day configuration grace, reclaim
    within the window restores everything.
12. **Custom CSS is v1.1.** MVP ships token-based theming only. The origin split
    (O1) is still built now so CSS drops in later without a URL migration.

## Origins

**O1. Which origin serves what.** Decided, permanent.

| | Origin (beta) | Serves |
|---|---|---|
| Public / user content | `system.doughmination.gay` | `/`, `/docs`, `/s/<pk-id>`, `/s/<slug>`, `/s/<slug>/<member>` |
| Application | `app.doughmination.gay` | `/login`, `/auth/...`, `/manage`, `/manage/...` |

One rule underneath: anything rendering user-authored presentation goes on the
public origin; anything reading or writing a session goes on the app origin.

`/s/...` lives on the public origin **from day one**, even though MVP has no
custom CSS. Those pages become user-authored presentation the moment v1.1 lands,
and moving them then would break every public URL ever shared — the exact
failure decision 8 exists to prevent. **The origin is therefore permanent.**

The public origin is the website people encounter and share. The app origin is
the private control surface behind it.

**O2. `__Host-` cookie prefix is non-negotiable.** It forbids a `Domain`
attribute, pinning the session cookie to exactly one host. That is the mechanism
making a sibling public origin safe — not the subdomain naming. It also prevents
cookie-tossing from the public side.

**O3. `/` is permanently logged-out.** It must NEVER be session-aware. The `__Host-` cookie physically cannot reach the
public origin, so these pages can never show "Signed in as …", "Your systems",
"Go to your dashboard", personalised recommendations, or any account state.

`/` carries an unconditional **Sign in** link to `<app origin>/login`. Any
signed-in landing experience belongs at `/manage` on the app origin.

Documentation is a separate site, so it carries no session either way.

## Public routes

All first-class, not afterthoughts. Split by origin per O1:

- **Public origin** — `/` landing and about, `/s/...` public system and member
  pages. **Documentation is a separate site** (`PUBLIC_DOCS_URL`) and is not
  served by this application; an empty value hides the links entirely.
- **App origin** — `/login`, `/auth/...` (OAuth is session-bearing by
  definition, so it belongs here beside `/login`), `/manage/...`.

## Beta

- `X-Robots-Tag: noindex, nofollow` on every response while `BETA_MODE=true`.
- Public viewing is never gated. **Claiming** is gated by
  `BETA_ALLOWED_DISCORD_IDS`.
- `SIGNUP_ENABLED` gates creating a *new* account only; existing testers can
  always sign in.
- Beta and production Discord redirect URIs are both registered ahead of the
  domain move, so the cutover needs no flag day.
- The old `/dispatch` endpoint stays alive across the move: PluralKit stores the
  webhook URL on its side and may not follow redirects on POST.

## Credentials

**C1. No PluralKit token is ever persisted in MVP.** A PK token is full
read/write — it can delete members. Tier-3 claim verification uses one within a
single request and discards it.

**C2. No feature may require a PluralKit token.** Tier 1 (Discord-linked account)
and tier 2 (description challenge) both work without one.

**C3. Authenticated responses never enter a public cache.** Enforced structurally
by `auth_scope` in the `pk_snapshots` primary key, not by convention.

**C4. Discord access tokens are discarded** immediately after the code exchange.
We read the user id once and never call Discord again — no refresh tokens, no
token table.

## PluralKit

**P1. One canonical User-Agent**, from config, non-overridable, pointing at the
**repository** rather than the deployment origin so it survives the domain move.

**P2. Limits are per-IP and our limiter is per-process.** Correct for a single
API process. A second instance behind the same egress IP requires a shared
limiter.

**P3. PluralKit downtime must not take public pages down.** Stale-while-revalidate
from `pk_snapshots`, with a visible "may be out of date" marker.

## UI

**U1. Bootstrap Icons via `react-bootstrap-icons`** is the standard icon set —
navigation, settings, socials, status, actions, auth, editing, alerts, menus,
chevrons, external links, privacy indicators, management. Named imports only
(`import { Github } from "react-bootstrap-icons"`), never namespace imports, so
it tree-shakes: the package sets `sideEffects: false` and ships an ESM entry.

A bespoke icon is introduced only where no suitable Bootstrap Icon exists and the
distinction matters to the product.

**U2. Bootstrap Icons are the icon source only.** The visual design is pkviewer's
own and does not adopt Bootstrap's styling.

## Security invariants

Properties the tests already demonstrate, written down so a later refactor
cannot weaken one by accident. Each names the test that would catch its loss.

**S1. The caller can never choose the identity used as proof of ownership.**
Tier-1 verification reads Discord ids from the authenticated session and
server-side account state only, never from request-controlled input. A request
body naming a Discord id must never influence which identity is treated as
proven. *Guarded by: "refuses when the system is not linked to the caller".*

**S2. A description challenge is bound to the `(account, system)` pair that
created it**, and can only be redeemed by that account. The lookup is keyed on
both, so another account presenting a valid challenge id gets
`challenge_not_found` — not a different error, and not a hint the challenge
exists. *Guarded by: "another account cannot verify someone else's challenge".*

**S3. Challenge verification never reads a cached description.** It fetches with
`maxAgeMs: 0`, which is an unconditional cache bypass rather than "fresh within
0ms". A stale copy must never prove ownership the user no longer holds.
*Guarded by: "maxAgeMs 0 always refetches, even within the same millisecond" and
"verification reads the description fresh, bypassing the cache".*

**S4. A PluralKit token is never persisted, cached or logged.** Tier 3 uses one
inside a single request and discards it. *Guarded by: "the token is never
persisted", which dumps every row of every table and asserts the token appears
nowhere.*

**S5. At most one owner per subject, enforced by the database.** The partial
unique index `idx_grants_single_owner` is the gate; the application-level check
exists only for a clean error message. *Guarded by: "the single-owner index
blocks a second owner row outright".*

**S6. Refusals leak nothing about who holds a thing.** `already_claimed` never
identifies the owner; a reserved slug reports only when the reservation lapses,
never the holder. *Guarded by: "a reserved slug is refused to others, without
naming the holder".*

**S7. Discord snowflakes are not public pkviewer identifiers.** Public `/s/...`
resolution must reject a Discord snowflake rather than resolving it to a system.

The distinction is deliberate and must be preserved:

- Discord ids MAY participate in authenticated ownership verification.
- Tier-1 claiming takes the Discord identity from authenticated session and
  account state, never from request input (see S1).
- Public URL resolution must NEVER turn a Discord id into a browsable system
  lookup.

Without this, pkviewer would expose a Discord-account to PluralKit-system
mapping through URL enumeration — a mapping PluralKit's API permits but which no
public pkviewer URL should hand out by guessing. *Guarded by: "a Discord
snowflake is refused as a public reference".*

**S8. A private member is indistinguishable from one that never existed** — even
when a pkviewer slug points at it. *Guarded by: "a slug pointing at a non-public
member resolves to nothing".*

**S9. The PluralKit UUID is the identity; the short id is mutable metadata.**
Grants, slugs, reservations, foreign keys and cache keys are all keyed on the
UUID. The short id is refreshed on claim because users can re-roll it, and is
used only for display and lookup. It must never become an identity.

**S10. Identity and navigation are separate.** A slug is a mutable presentation
label. Changing one never changes what a system or member *is*, and never
transfers anything.

## Slugs

**L1. System slugs may not take the shape of a PluralKit short id**
(`[a-z]{5,6}`). System slugs and system ids share one global namespace at
`/s/<ref>`, so an id-shaped slug could shadow another system's id URL — a URL
its owner never gave up. Removing the shape from the namespace removes the
ambiguity with no lookup required.

**Member slugs are deliberately not restricted this way.** They are namespaced
per system, so a collision can only shadow a member of a system the claimant
already controls: self-inflicted, not an attack. Claiming one warns
(`shadows_member_id`) rather than refusing, which keeps ordinary names like
`clove` available where people actually want them.

**L1b. A slug must not contain `--` anywhere.** Stated as the literal substring
rather than "no consecutive hyphens", so every validator enforces exactly the
same rule. The purpose is to keep the punycode marker `xn--` unclaimable, so
slugs stay safe to place in a hostname if per-system subdomains ever happen.

**L2. `SLUG_MAX_LENGTH` is 32, below a UUID's 36.** This guarantees no slug can
ever shadow `/s/<uuid>`, so every system keeps one permanently unambiguous URL
no matter what anyone claims. Raising this limit past 35 would break that.

**L3. Resolution is slug first, then id**, and neither redirects — both return
200 and the canonical form is advertised with `<link rel="canonical">`. A 301
would outlive slug ownership and permanently point a cached URL at whoever holds
the name next.

**L4. A subject holds at most one active slug per scope.** Claiming a new one
releases the previous into its own 7-day reservation rather than freeing it, so
a rename cannot be used to snipe the old URL and the owner can change their mind.

**L5. Reservations follow the subject, not the account.** A different account
managing the same system can reclaim a slug that system released.

## Unclaiming

**Unclaiming removes management access. Reclaiming within the grace period
restores the saved configuration, but does not restore previous manager
grants.** Every grant is deleted on unclaim, not just the owner's — an unclaimed
system genuinely has no managers. The 30-day grace window restores themes and
reserved slugs; anyone who was previously a manager must be re-invited.

## Theme vocabulary

The product's public design API. Locked in step 8; changing it is a product
decision, not a refactor. Lives in `packages/shared/src/theme/`.

**T1. Theme is how things look. Composition is what appears and how it is
arranged.** A knob that changes which information is on the page, or where it
sits, is composition. A knob that changes the appearance of whatever is there is
a theme token. This is why `directory.columns` is composition and `shape.radius`
is a token — and why `directory.card.min` never became a token at all: the
renderer needed a pixel value, but the product concept is "how many columns".

**T2. Named options, never free values.** A user picks `relaxed`, not `1.3`.
Every enum maps to concrete CSS in exactly one function, so the scale can be
retuned later without invalidating a single stored theme. This is what keeps the
product from being "CSS custom properties with a UI".

**T3. Colour is six-digit hex only.** Not `rgb()`, not `color-mix()`, not named
colours, not three-digit hex. One shape is trivial to validate, trivial to put
behind a colour picker, and leaves no room for a function call to smuggle
something through.

**T4. Fonts come from a fixed table of eight**, each either the system stack or
a Google Fonts family. A font token carries an id, never a family name and never
a URL, so a theme can never point the browser at a resource we did not choose.

**T5. One colour value per token, not one per scheme.** The platform default
carries both light and dark grounds; a custom colour applies to whichever ground
is active. Doubling the vocabulary to carry two of every colour would be the
wrong trade for a non-technical editor.

### Theme tokens (14)

| Key | Type | Default | Member |
|---|---|---|---|
| `color.scheme` | enum auto/light/dark | `auto` | no |
| `color.page` | color | `#FAF8FB` / `#151219` | yes |
| `color.surface` | color | `#FFFFFF` / `#1E1A24` | yes |
| `color.text` | color | `#1C1721` / `#EEEAF2` | yes |
| `color.muted` | color | `#6B6478` / `#9A93A6` | yes |
| `color.accent` | color | `#A23B72` / `#F58FC2` | yes |
| `color.border` | color | `#E6E1EC` / `#302938` | yes |
| `font.body` | font | `system` | yes |
| `font.heading` | font | `newsreader` | yes |
| `font.size` | enum small/medium/large | `medium` | yes |
| `shape.radius` | enum none/small/medium/large | `medium` | yes |
| `surface.style` | enum outlined/filled/plain | `outlined` | yes |
| `density` | enum compact/normal/relaxed | `normal` | yes |
| `avatar.shape` | enum circle/rounded/square | `rounded` | yes |

`color.scheme` is the only system-only token. It is a property of the SITE: a
member page flipping to dark while the system page is light reads as broken
navigation rather than personal expression. Everything else is member
overridable, because a member page being visually its own thing is the point.

### Composition configuration (7)

Separate vocabulary, separate storage, not CSS custom properties.

| Key | Type | Default | Member |
|---|---|---|---|
| `banner.display` | enum auto/hidden | `auto` | yes |
| `avatar.size` | enum small/medium/large | `medium` | yes |
| `directory.columns` | enum auto/one/two/three | `auto` | no |
| `directory.card` | enum compact/detailed | `compact` | no |
| `directory.sort` | enum pluralkit/name | `pluralkit` | no |
| `show.pronouns` | boolean | `true` | yes |
| `show.birthday` | boolean | `true` | yes |

Directory settings are system-only: the directory belongs to the system page,
so a member has nothing to override there.

### The `length` and `boolean` types

Both are implemented and tested in the validation layer. No MVP theme token uses
`length` — every dimension is a named option instead, which is what keeps
arbitrary values out. Tokens were not invented merely to exercise a type.

### Presets (5)

Applied by copying values into a system theme, so a preset is a starting point
rather than a mode: everything stays editable, and a preset can be retuned later
without silently changing anyone's page.

- **Notebook** — the default, refined. Warm off-white, serif headings, soft
  outlined cards, normal density.
- **Broadsheet** — editorial and dense. Display serif, square corners, hairline
  rules instead of cards, compact.
- **Bloom** — soft and friendly. Rounded typeface, large radius, filled cards,
  circular avatars, relaxed.
- **Terminal** — deliberately technical. Monospaced, near-black, square, no card
  decoration, compact.
- **Midnight** — modern dark. Geometric headings, filled cards, soft corners.

They differ in typeface, corner treatment, card style, density and ground — a
test asserts that, so five colour swaps could not pass for five presets.

### Inheritance

`platform default -> system theme -> member override`, with the three states
already locked: absent inherits, a value overrides, and an explicit `null` resets
to the platform default while ignoring the system. That third state is what lets
a member escape a loud system theme without restating every default by hand.

Member-overridability is enforced in validation, not merely ignored at render, so
an editor can say why something was refused.

## Management plane

**M1. The server is authoritative for authorization.** Every management read and
write re-checks the grant server-side. The client can ask about any system id it
likes; it is told 404 for every one it does not manage.

**M2. Unauthorised access reports 404, never 403.** A 403 would confirm the
system exists on pkviewer, which an unauthorised caller should not be able to
probe for.

**M3. A save is all or nothing.** If any value in a save is rejected, nothing is
written. Dropping the invalid keys and saving the rest would silently discard
settings the user already had — a destructive save wearing the costume of a
validation error. *Guarded by: "a rejected save leaves existing settings
untouched".*

**M4. Theme and composition are written independently.** A save names the layer
it touches, so saving appearance can never wipe directory settings. *Guarded by:
"saving one layer leaves the other untouched".*

**M5. The management UI does not reveal private members.** It lists the members
PluralKit returns publicly, from the same public request the public site makes.
Being signed in as the owner does not change what the public API returns and
pkviewer does not ask for more, so a private member is absent here and 404s
individually. *Guarded by: "a member PluralKit withholds is absent, and 404s
individually".*

**M6. The management app has its own visual language.** It never inherits the
user's public theme: it must look the same whichever system you are editing. Its
custom properties are namespaced `--mg-*` so they cannot collide with the
`--pkv-*` tokens a preview renders with.

**M7. One source of truth for how a token becomes a style.** The editor's
preview calls the same `resolveTheme` and `themeToCssVars` the public renderer
does. Only the sample content is local to the editor.

**M8. The browser never talks to the API directly.** Server components and
server actions forward the session cookie, so `INTERNAL_API_ORIGIN` stays
internal and the `__Host-` cookie's host pinning is never loosened to permit a
cross-origin call.

**M9. Inheritance is UI, not data the user authors.** Nobody types `null`,
deletes a field, or edits JSON. A control is either following what it inherits
or explicitly set, with buttons to move between those states. Inherited versus
overridden is shown by a word and a border, never by colour alone.

**M10. Applying a preset at member level is an explicit member configuration.**
It never reaches up and changes the system.

## Public addresses

The public URL is a product feature, not an implementation detail. "Slug" is
internal vocabulary; the UI says **address** throughout.

**U3. A chosen address is never required for a page to be public.** A claimed
system is reachable at its PluralKit ID address from the moment it is claimed. A
chosen address only makes the link friendlier to share, and the ID address keeps
working afterwards. The no-address state says so plainly rather than reading as
an incomplete setup.

**U4. Copying is never the only way to get an address.** Every public URL is
shown as selectable text and offered as an ordinary link alongside the copy
button, so it works without JavaScript, without clipboard permission, and for
anyone who would rather select it by hand. Copy success is announced in words
through a live region, never signalled by colour alone.

**U5. Availability checks are advisory.** The client checks as you type purely
for immediate feedback; the claim path re-checks transactionally, because
availability can change between the two. The server's answer is the only one
that counts.

**U6. A held address never names its holder.** A conflict reports only that the
address is held and when the hold lapses. Neither the holding system nor its
managers appear anywhere in the response.

**U7. Changing an address breaks links to the old one.** The old address enters
its 7-day hold immediately and stops resolving; it is not redirected, because a
redirect would outlive ownership. The UI says this before the change, not after.

## Audit findings (step 11)

**A4. Nothing may be statically prerendered if it embeds a configured origin.**
Prerendering bakes the BUILD-TIME origin into the HTML, so the beta-to-production
move would need a rebuild rather than an env change — which is precisely what
decision 1 forbids. `/`, `/docs` and the not-found page are therefore
`force-dynamic`. Verified by building with one origin and serving with another.

**A5. A visibility setting removes the value, it does not hide it.** `show.pronouns`
and `show.birthday` strip the field in the page model rather than omitting it in
markup, so a hidden value is not shipped in the page source at all. This is
public PluralKit data either way, but a setting should do what it says.

**A6. The three inheritance states must survive storage.** A reset is stored as
an explicit null; reading a layer through a string-only filter collapsed three
states into two and made "use the platform default" land on the system's value.
Stored layers are read as `Record<string, string | null>`.

**A7. Staleness is measured against the reference that was actually fetched.**
A slug resolves through the stored UUID and an id through the id itself, so
asking "how old is this data" under a guessed key silently missed for id-based
URLs. `ResolvedSystem.cacheRef` carries the key that was used.

**A8. Audit breadcrumbs must not block account deletion.** `grants.granted_by`
and `themes.updated_by` record who did something; they are not ownership. Left
without an `ON DELETE` rule they defaulted to RESTRICT, so deleting an account
that had ever granted a role or saved a theme failed outright — and account
deletion is a stated requirement. Both are now `ON DELETE SET NULL`
(migration 004). *Guarded by: "an account that has granted a role and saved a
theme can be deleted".*

### Known limitation

`notFound()` called under a layout that has already streamed renders the correct
page but does not set a 404 status, so unauthorised `/manage/<id>` returns 200
with the right content. Confirmed in both dev and production builds. The content
is correct and discloses nothing — a system that does not exist and one that
belongs to someone else are indistinguishable — and every management page is
`noindex`. Worth revisiting if it ever matters for monitoring.

## Guardrails

No user JavaScript, ever. No arbitrary HTML. No custom CSS in MVP. No
server-side fetching of user-supplied URLs (SSRF) — social links are rendered as
links and never fetched for previews or favicons. Public pages show only what
PluralKit makes public. Fonts come from a fixed allow-list; no arbitrary font
URLs or uploads.
