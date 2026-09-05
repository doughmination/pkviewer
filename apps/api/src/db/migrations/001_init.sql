-- pkviewer initial schema.
--
-- Three data domains are kept structurally apart:
--   * pkviewer metadata  — accounts, grants, slugs, themes, socials (authoritative)
--   * PluralKit cache    — pk_snapshots (never authoritative, always re-derivable)
--   * audit              — append-only record of security-relevant actions
--
-- All timestamps are integer Unix milliseconds UTC. Text dates make the slug
-- reservation comparison subtly wrong, so they are not used anywhere.

-- ---------------------------------------------------------------- identity --

CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER
) STRICT;

-- Separate from accounts so one account can hold several Discord identities
-- later without a migration.
CREATE TABLE discord_identities (
  discord_user_id TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  username        TEXT,
  global_name     TEXT,
  avatar_hash     TEXT,
  linked_at       INTEGER NOT NULL,
  last_login_at   INTEGER
) STRICT;

CREATE INDEX idx_discord_identities_account ON discord_identities(account_id);

-- `id` holds the SHA-256 of the cookie value, never the value itself, so a
-- database read does not yield usable sessions.
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  abs_expires_at  INTEGER NOT NULL,
  revoked_at      INTEGER,
  ua_hash         TEXT,
  ip_hash         TEXT
) STRICT;

CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_expiry ON sessions(abs_expires_at);

-- ---------------------------------------------------------------- subjects --

CREATE TABLE systems (
  id             TEXT PRIMARY KEY,
  pk_system_uuid TEXT NOT NULL UNIQUE,
  pk_system_hid  TEXT NOT NULL,
  claimed_at     INTEGER,
  unclaimed_at   INTEGER,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_systems_hid ON systems(pk_system_hid);

-- Rows are created lazily: only members we hold local data about (a slug, a
-- theme, socials) need one.
CREATE TABLE members (
  id             TEXT PRIMARY KEY,
  system_id      TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  pk_member_uuid TEXT NOT NULL UNIQUE,
  pk_member_hid  TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_members_system ON members(system_id);

-- Authorization is expressed as grants over a subject rather than a column on
-- systems. MVP only ever writes subject_type='system', but member-level
-- principals (decision 9) can be added later by writing 'member' rows — no
-- schema migration, and one authorization module to update.
CREATE TABLE grants (
  id           INTEGER PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('system','member')),
  subject_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','manager')),
  granted_at   INTEGER NOT NULL,
  granted_by   TEXT REFERENCES accounts(id),
  UNIQUE (account_id, subject_type, subject_id)
) STRICT;

CREATE INDEX idx_grants_subject ON grants(subject_type, subject_id);

-- ------------------------------------------------------------------- slugs --
--
-- A slug is an entity with a lifecycle, not a string column on its subject.
-- Uniqueness is enforced here by the database, which is what makes simultaneous
-- claims safe: a claim is a single conditional write, never read-then-write.
--
-- Namespaces: system slugs are global (scope_key = ''); member slugs are scoped
-- to their system (scope_key = systems.id).
--
-- Reservation is subject-owned (decision 6): the reclaim right follows the
-- system or member, not the account that happened to hold it.

CREATE TABLE slugs (
  id              INTEGER PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('system','member')),
  scope_key       TEXT NOT NULL,
  slug_normalized TEXT NOT NULL,
  slug_display    TEXT NOT NULL,

  state           TEXT NOT NULL CHECK (state IN ('active','reserved')),
  subject_id      TEXT,

  reserved_principal_type TEXT CHECK (reserved_principal_type IN ('system','member')),
  reserved_principal_id   TEXT,
  reserved_until          INTEGER,

  claimed_at      INTEGER,
  released_at     INTEGER,

  UNIQUE (scope, scope_key, slug_normalized),

  -- State consistency is a constraint, not a convention: an 'active' row with a
  -- reservation, or a 'reserved' row with no expiry, cannot be written at all.
  CHECK (
    (state = 'active'
      AND subject_id IS NOT NULL
      AND reserved_until IS NULL
      AND reserved_principal_type IS NULL
      AND reserved_principal_id IS NULL)
    OR
    (state = 'reserved'
      AND subject_id IS NULL
      AND reserved_until IS NOT NULL
      AND reserved_principal_type IS NOT NULL
      AND reserved_principal_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_slugs_subject ON slugs(scope, subject_id);
CREATE INDEX idx_slugs_reserved ON slugs(state, reserved_until);

CREATE TABLE slug_history (
  id         INTEGER PRIMARY KEY,
  slug_id    INTEGER NOT NULL REFERENCES slugs(id) ON DELETE CASCADE,
  event      TEXT NOT NULL CHECK (event IN ('claimed','released','reclaimed','expired','transferred')),
  subject_id TEXT,
  account_id TEXT,
  at         INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_slug_history_slug ON slug_history(slug_id, at);

-- ------------------------------------------------------------ presentation --
--
-- Tokens are a sparse JSON blob validated in application code. They are always
-- read as a complete set and never queried by individual key, so a key/value
-- table would add joins on every page render and buy nothing.
--
-- css_source / css_compiled are unused in MVP (custom CSS is v1.1, decision 12)
-- but the columns exist so adding it later is not a schema change.

CREATE TABLE themes (
  owner_type     TEXT NOT NULL CHECK (owner_type IN ('system','member')),
  owner_id       TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  tokens         TEXT NOT NULL DEFAULT '{}',
  css_source     TEXT,
  css_compiled   TEXT,
  css_hash       TEXT,
  css_errors     TEXT,
  updated_at     INTEGER NOT NULL,
  updated_by     TEXT REFERENCES accounts(id),
  deleted_at     INTEGER,
  PRIMARY KEY (owner_type, owner_id)
) STRICT;

CREATE TABLE social_links (
  id         INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('system','member')),
  owner_id   TEXT NOT NULL,
  platform   TEXT NOT NULL,
  label      TEXT,
  url        TEXT NOT NULL,
  visible    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_socials_owner ON social_links(owner_type, owner_id, sort_order);

-- ------------------------------------------------------------- PK snapshots --
--
-- auth_scope sits in the primary key deliberately. It is the structural reason
-- an authenticated PluralKit response can never be served to a public visitor —
-- a code convention someone can forget would not be good enough.
--   'public'  = fetched with no credential
--   <acct id> = fetched with that account's explicitly provided credential

CREATE TABLE pk_snapshots (
  ref_type   TEXT NOT NULL CHECK (ref_type IN ('system','members','member','fronters')),
  ref_key    TEXT NOT NULL,
  auth_scope TEXT NOT NULL DEFAULT 'public',
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  etag       TEXT,
  PRIMARY KEY (ref_type, ref_key, auth_scope)
) STRICT;

CREATE INDEX idx_pk_snapshots_fetched ON pk_snapshots(fetched_at);

-- ------------------------------------------------------------------- audit --

CREATE TABLE audit_events (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  account_id TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT
) STRICT;

CREATE INDEX idx_audit_at ON audit_events(at);
CREATE INDEX idx_audit_account ON audit_events(account_id, at);
