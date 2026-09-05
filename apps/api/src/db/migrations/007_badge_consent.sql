-- Badges that do not wait for an answer.
--
-- Consent is the right default and stays the default: a badge appears on
-- someone's page and describes them to their visitors, so "Girlfriend" or a
-- vulnerability credit must be offered rather than imposed (R5).
--
-- PK Dev is the case that does not fit. The people it recognises are PluralKit
-- developers who have no reason to hold a pkviewer account, and an offer nobody
-- can receive is not an offer — it is a badge that never appears. Requiring
-- them to sign up to a third-party site to be acknowledged inverts the point of
-- acknowledging them.
--
-- What makes that acceptable, and what would NOT make it acceptable for the
-- others:
--
--   * it states a public, professional fact — someone works on PluralKit —
--     rather than anything personal or private;
--   * it is not a claim about them made by pkviewer's owner, it is a
--     description of a role they already hold publicly;
--   * it remains removable. The moment they claim their system it appears in
--     their management page like any other badge, and Decline works normally.
--     Until then, asking gets it revoked.
--
-- This is a column rather than a hardcoded badge id so the decision is visible
-- in the data and reviewable in one query, instead of living in a branch
-- somewhere that reads `if (badgeId === 'pk-dev')`.
--
-- It is deliberately NOT editable over HTTP. Turning off consent for a badge is
-- a considered decision, not a checkbox in an admin form — a future badge that
-- needs it should arrive as a migration that says why, like this one.

ALTER TABLE badges ADD COLUMN consent_required INTEGER NOT NULL DEFAULT 1;

UPDATE badges SET consent_required = 0 WHERE id = 'pk-dev';
