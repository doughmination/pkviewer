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
-- left to say.
--
-- The trade is real and worth stating: a badge can now appear on somebody's
-- page before they have seen it. What makes that acceptable is that removal
-- stayed exactly where it was — Hide and Decline work as before, an admin can
-- revoke, and a hidden badge is indistinguishable from one never granted. What
-- changed is the default, not the control.
--
-- `pending` stays in the state CHECK. Nothing writes it now, but rebuilding
-- subject_badges to forbid a state no row holds would be churn for nothing.
--
-- ------------------------------------------------- why DROP COLUMN, not a rebuild --
--
-- The first version of this migration rebuilt `badges` the way 005 rebuilds
-- `grants`: create, copy, drop, rename. It passed every test and failed on the
-- first deployment that had actually granted a badge, with
--
--     SQLiteError: there is already another table or index with this name: badges
--
-- The rename collides only when `foreign_keys = ON` AND a row in
-- `subject_badges` references `badges`. Dropping a parent table that a child
-- row still points at leaves the name in a state the following rename cannot
-- take. 005 survives the same pattern purely because nothing references
-- `grants`.
--
-- The standard remedy is `PRAGMA foreign_keys = OFF` around the rebuild, and
-- it does not work here: migrations run inside a transaction and that pragma
-- is a no-op inside one. Turning enforcement off for every migration would be
-- worse than the problem.
--
-- So: no rebuild. Dropping one column needs no new table, cannot collide with
-- anything, and keeps `idx_badges_order` intact.

UPDATE subject_badges
   SET state = 'accepted',
       responded_at = COALESCE(responded_at, granted_at)
 WHERE state = 'pending';

ALTER TABLE badges DROP COLUMN consent_required;

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
