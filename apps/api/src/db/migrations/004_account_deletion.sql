-- Make account deletion possible.
--
-- `grants.granted_by` and `themes.updated_by` are audit breadcrumbs: they record
-- who did something, and are not ownership. They were declared as plain
-- references with no ON DELETE rule, which defaults to RESTRICT — so deleting an
-- account that had ever granted a role or saved a theme failed with a foreign
-- key error, and account deletion is a stated requirement.
--
-- SQLite cannot alter a constraint, so both tables are rebuilt. Nothing
-- references either table, so no dependent rows are disturbed.

CREATE TABLE grants_new (
  id           INTEGER PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('system','member')),
  subject_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','manager')),
  granted_at   INTEGER NOT NULL,
  -- The breadcrumb survives as NULL rather than blocking the delete.
  granted_by   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  verification_method TEXT,
  verified_at  INTEGER,
  UNIQUE (account_id, subject_type, subject_id)
) STRICT;

INSERT INTO grants_new
  (id, account_id, subject_type, subject_id, role, granted_at, granted_by, verification_method, verified_at)
SELECT id, account_id, subject_type, subject_id, role, granted_at, granted_by, verification_method, verified_at
  FROM grants;

DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;

CREATE INDEX idx_grants_subject ON grants(subject_type, subject_id);

-- At most one owner per subject. Rebuilt with the table it guards.
CREATE UNIQUE INDEX idx_grants_single_owner
  ON grants (subject_type, subject_id) WHERE role = 'owner';

CREATE TABLE themes_new (
  owner_type     TEXT NOT NULL CHECK (owner_type IN ('system','member')),
  owner_id       TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  tokens         TEXT NOT NULL DEFAULT '{}',
  composition    TEXT NOT NULL DEFAULT '{}',
  css_source     TEXT,
  css_compiled   TEXT,
  css_hash       TEXT,
  css_errors     TEXT,
  updated_at     INTEGER NOT NULL,
  updated_by     TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  deleted_at     INTEGER,
  PRIMARY KEY (owner_type, owner_id)
) STRICT;

INSERT INTO themes_new
  (owner_type, owner_id, schema_version, tokens, composition,
   css_source, css_compiled, css_hash, css_errors, updated_at, updated_by, deleted_at)
SELECT owner_type, owner_id, schema_version, tokens, composition,
       css_source, css_compiled, css_hash, css_errors, updated_at, updated_by, deleted_at
  FROM themes;

DROP TABLE themes;
ALTER TABLE themes_new RENAME TO themes;
