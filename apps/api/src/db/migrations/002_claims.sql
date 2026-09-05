-- System claiming.
--
-- Claiming a system on pkviewer is NOT ownership of the underlying PluralKit
-- system. It grants control of how that system is presented here, nothing more.

CREATE TABLE claim_challenges (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pk_system_uuid TEXT NOT NULL,
  pk_system_hid  TEXT NOT NULL,
  -- Published by the user into their own system description, so this is a
  -- proof token rather than a secret. It is still single-use and expiring.
  nonce          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  consumed_at    INTEGER,
  UNIQUE (account_id, pk_system_uuid)
) STRICT;

CREATE INDEX idx_claim_challenges_expiry ON claim_challenges(expires_at);

-- At most one owner per subject, enforced by the database.
--
-- Decision 7 blocks a contested takeover automatically. Doing that with a
-- SELECT-then-INSERT would leave a race between two simultaneous claimants;
-- this index removes the race entirely, exactly as the slug UNIQUE does.
CREATE UNIQUE INDEX idx_grants_single_owner
  ON grants (subject_type, subject_id) WHERE role = 'owner';

-- How ownership was proven, and when. Re-verification flags a stale claim for
-- review; it never auto-revokes, because a PluralKit API hiccup must not cost
-- someone their system.
ALTER TABLE grants ADD COLUMN verification_method TEXT;
ALTER TABLE grants ADD COLUMN verified_at INTEGER;
