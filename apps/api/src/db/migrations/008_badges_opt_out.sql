-- Badges become opt-out, and an Early Access bug hunter joins the catalogue.
--
-- ---------------------------------------------------------------- opt-out --
--
-- Recognition was opt-in: a grant landed as `pending` and showed nothing until
-- its recipient accepted (R5). Migration 007 carved out PK Dev, because the
-- people it names have no reason to hold a pkviewer account and an offer
-- nobody can receive is a badge that never appears.
--
-- That carve-out is now the rule. Every badge is accepted on arrival and the
-- recipient turns it off if they want to, so `consent_required` has nothing
-- left to say and the column goes rather than sitting at a constant.
--
-- The trade is real and worth stating: a badge can now appear on somebody's
-- page before they have seen it. What makes that acceptable is that removal
-- stayed exactly where it was — Hide and Decline work as before, an admin can
-- revoke, and a hidden badge is indistinguishable from one never granted. What
-- changed is the default, not the control.
--
-- `pending` stays in the state CHECK. Nothing writes it now, but rebuilding
-- subject_badges to forbid a state no row holds would be churn for nothing,
-- and the column would then disagree with the audit log's history.

UPDATE subject_badges
   SET state = 'accepted',
       responded_at = COALESCE(responded_at, granted_at)
 WHERE state = 'pending';

CREATE TABLE badges_new (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT NOT NULL,
  tone        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  retired_at  INTEGER,
  created_at  INTEGER NOT NULL
) STRICT;

INSERT INTO badges_new (id, label, description, icon, tone, sort_order, retired_at, created_at)
SELECT id, label, description, icon, tone, sort_order, retired_at, created_at FROM badges;

DROP TABLE badges;
ALTER TABLE badges_new RENAME TO badges;

-- Rebuilt with the table, exactly as 005 defined it. A partial or plain index
-- is dropped along with the table it sits on, and forgetting one here would be
-- invisible until the catalogue grew.
CREATE INDEX idx_badges_order ON badges(sort_order, id);

-- ------------------------------------------------------------ EA bug hunter --
--
-- Separate from Bug Hunter rather than the same badge with a note: finding a
-- bug in Early Access is a different thing from finding one in a settled
-- product. It means someone used pkviewer while it was still visibly rough and
-- reported what broke, which is worth naming on its own.

INSERT INTO badges (id, label, description, icon, tone, sort_order, created_at) VALUES
  ('ea-bug-hunter', 'EA Bug Hunter',
   'Found and reported a bug during pkviewer''s early access.',
   'patch', 'slate', 45, 0)
ON CONFLICT (id) DO NOTHING;
