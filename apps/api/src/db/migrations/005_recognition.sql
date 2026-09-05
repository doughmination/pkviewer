-- Recognition: badges granted by the platform, and the project credits page.
--
-- Two related but separate concepts, deliberately not one table:
--
--   * A BADGE is attached to a pkviewer system and appears on its public page.
--     It says "pkviewer recognises this system as X".
--   * A CREDIT is an entry on the project's credits page. It needs no account,
--     no PluralKit system, and no pkviewer presence at all — someone who
--     reports a vulnerability by email gets credited without ever signing in.
--
-- Someone can have either, both, or neither. Merging them would force a
-- pkviewer system onto people who do not have one.

-- ------------------------------------------------------------ admin grants --
--
-- Admin is a grant over the platform, not a column on accounts.
--
-- `grants` already models authorization as a role over a subject, and reusing
-- it means there is ONE authorization table and one place to reason about who
-- may do what. It also produces the scope separation for free: authorizeSystem
-- looks up a grant whose subject_id is a specific system, so a platform grant
-- can never satisfy it. An admin administers pkviewer; an admin does not
-- silently gain access to anyone's system, theme or slug.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.

CREATE TABLE grants_new (
  id           INTEGER PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('system','member','platform')),
  subject_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','manager','admin')),
  granted_at   INTEGER NOT NULL,
  granted_by   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  verification_method TEXT,
  verified_at  INTEGER,
  UNIQUE (account_id, subject_type, subject_id),
  -- The platform is a single subject; 'admin' means nothing over a system.
  CHECK (
    (subject_type = 'platform' AND subject_id = 'pkviewer' AND role = 'admin')
    OR
    (subject_type IN ('system','member') AND role IN ('owner','manager'))
  )
) STRICT;

INSERT INTO grants_new
  (id, account_id, subject_type, subject_id, role, granted_at, granted_by,
   verification_method, verified_at)
SELECT id, account_id, subject_type, subject_id, role, granted_at, granted_by,
       verification_method, verified_at
  FROM grants;

DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;

CREATE INDEX idx_grants_account ON grants(account_id);
CREATE INDEX idx_grants_subject ON grants(subject_type, subject_id);

-- At most one owner per subject. A partial unique index is dropped with the
-- table it sits on, so a rebuild that forgets it silently permits a second
-- owner row — which is a contested-claim bug, not an indexing one. Rebuilt here
-- exactly as 004 defined it.
CREATE UNIQUE INDEX idx_grants_single_owner
  ON grants (subject_type, subject_id) WHERE role = 'owner';

-- ----------------------------------------------------------- badge catalogue --
--
-- The catalogue is data so a new badge type is an admin action rather than a
-- deploy. Its LABEL and DESCRIPTION are admin-authored text.
--
-- `icon` and `tone` are not: they are keys checked against a fixed list in
-- application code before a row is written, and the renderer maps them to a
-- component and a class. Nothing in this table ever becomes markup, a style
-- attribute, or a URL. That is what keeps badge appearance platform-controlled
-- while the catalogue stays extensible.

CREATE TABLE badges (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT NOT NULL,
  tone        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  -- Retired badges keep rendering where already granted, but cannot be granted
  -- again. Deleting the row instead would silently strip it from pages.
  retired_at  INTEGER,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_badges_order ON badges(sort_order, id);

-- --------------------------------------------------------- badge assignment --
--
-- A badge appears on someone's page and says something about them, so it is an
-- OFFER rather than a fact: "Girlfriend" discloses a relationship, and a
-- vulnerability-finder badge names someone who may prefer not to be publicly
-- associated with a disclosure. The recipient decides.
--
--   pending   granted, awaiting the recipient
--   accepted  visible on the public page — the ONLY state that renders
--   declined  recipient said no; kept so it is not offered again by accident
--   hidden    accepted once, currently hidden by the recipient
--   revoked   taken back by an admin
--
-- subject_type follows the grants convention. Only 'system' is written today:
-- a badge recognises the system, and repeating it on every member page would
-- both misattribute it and turn one grant into a page full of noise.

CREATE TABLE subject_badges (
  id           INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('system','member')),
  subject_id   TEXT NOT NULL,
  badge_id     TEXT NOT NULL REFERENCES badges(id) ON DELETE RESTRICT,

  state        TEXT NOT NULL CHECK (state IN ('pending','accepted','declined','hidden','revoked')),

  -- A short admin note shown to the recipient with the offer ("for the CSP
  -- report"). Never rendered on a public page.
  note         TEXT,

  granted_at   INTEGER NOT NULL,
  -- Breadcrumb, not ownership: an admin account can be deleted without taking
  -- the badge with it (A8).
  granted_by   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  responded_at INTEGER,
  revoked_at   INTEGER,
  revoked_by   TEXT REFERENCES accounts(id) ON DELETE SET NULL,

  -- One badge per subject. Re-granting a revoked badge updates this row, so the
  -- history stays in audit_events rather than accumulating duplicates here.
  UNIQUE (subject_type, subject_id, badge_id)
) STRICT;

CREATE INDEX idx_subject_badges_subject ON subject_badges(subject_type, subject_id, state);
CREATE INDEX idx_subject_badges_badge ON subject_badges(badge_id);

-- ------------------------------------------------------------------ credits --
--
-- Sections are rows rather than an enum in the page, so adding "Translators"
-- is an admin action and the public page has no list of categories in it.

CREATE TABLE credit_sections (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_credit_sections_order ON credit_sections(sort_order, id);

CREATE TABLE credits (
  id          TEXT PRIMARY KEY,
  section_id  TEXT NOT NULL REFERENCES credit_sections(id) ON DELETE RESTRICT,
  -- A display name the person chose. Not an account, not a PluralKit handle:
  -- crediting someone must not require them to have either.
  name        TEXT NOT NULL,
  -- What they did. Free text, admin-authored, rendered as text.
  detail      TEXT,
  -- Optional and http(s) only, validated in application code exactly like a
  -- social link. Rendered as a link and never fetched.
  url         TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  visible     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT REFERENCES accounts(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_credits_section ON credits(section_id, sort_order, id);

-- -------------------------------------------------------------------- seed --

INSERT INTO badges (id, label, description, icon, tone, sort_order, created_at) VALUES
  ('owner', 'Owner',
   'Runs pkviewer.', 'star', 'gold', 10, 0),
  ('girlfriend', 'Girlfriend',
   'The owner''s girlfriend.', 'heart', 'rose', 20, 0),
  ('friend', 'Friend',
   'A friend of the project.', 'people', 'violet', 30, 0),
  ('bug-hunter', 'Bug Hunter',
   'Found and reported a bug.', 'bug', 'amber', 40, 0),
  ('security', 'Security Researcher',
   'Reported a security vulnerability responsibly.', 'shield', 'teal', 50, 0),
  ('contributor', 'Contributor',
   'Contributed to pkviewer.', 'code', 'blue', 60, 0);

INSERT INTO credit_sections (id, label, description, sort_order, created_at) VALUES
  ('security', 'Security Researchers',
   'Reported vulnerabilities privately and gave us time to fix them.', 10, 0),
  ('bug-hunters', 'Bug Hunters',
   'Found and reported bugs.', 20, 0),
  ('contributors', 'Contributors',
   'Wrote code, docs or design.', 30, 0),
  ('testers', 'Testers', 'Used pkviewer early and said what was wrong.', 40, 0),
  ('thanks', 'Special Thanks', NULL, 50, 0);
