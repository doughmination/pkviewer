import type { Db } from "../db/index.ts";

/**
 * Slug lifecycle: release, reservation, reclaim.
 *
 * Claiming and validation land in the next step; unclaiming a system needs
 * release and reclaim now, and they are the security-relevant half.
 *
 * Two rules carry this feature:
 *
 *  1. Uniqueness is enforced by the database (`UNIQUE (scope, scope_key,
 *     slug_normalized)`), so a claim is a single conditional write and two
 *     simultaneous claimants cannot both win.
 *
 *  2. Expiry is computed at read time, never by a scheduled job. A cron that
 *     "frees expired slugs" is wrong in every failure mode: a missed run locks a
 *     slug forever, clock skew frees it early, and a slow run lets two claimants
 *     both see it as free. Deriving state from `reserved_until` at the moment of
 *     the query is always correct.
 */

export const RESERVATION_MS = 7 * 24 * 60 * 60 * 1000;

export type SlugScope = "system" | "member";
export type PrincipalType = "system" | "member";

export type SlugRow = {
  id: number;
  scope: SlugScope;
  scope_key: string;
  slug_normalized: string;
  slug_display: string;
  state: "active" | "reserved";
  subject_id: string | null;
  reserved_principal_type: PrincipalType | null;
  reserved_principal_id: string | null;
  reserved_until: number | null;
  claimed_at?: number | null;
};

/** What a slug effectively is right now, given the clock. */
export type EffectiveState =
  | { kind: "active"; subjectId: string }
  | { kind: "reserved"; principalType: PrincipalType; principalId: string; until: number }
  | { kind: "free" };

export function effectiveState(row: SlugRow, now: number): EffectiveState {
  if (row.state === "active" && row.subject_id) {
    return { kind: "active", subjectId: row.subject_id };
  }
  if (
    row.state === "reserved" &&
    row.reserved_until !== null &&
    row.reserved_principal_type !== null &&
    row.reserved_principal_id !== null
  ) {
    if (now >= row.reserved_until) return { kind: "free" };
    return {
      kind: "reserved",
      principalType: row.reserved_principal_type,
      principalId: row.reserved_principal_id,
      until: row.reserved_until,
    };
  }
  return { kind: "free" };
}

export function findSlug(
  db: Db,
  scope: SlugScope,
  scopeKey: string,
  slugNormalized: string,
): SlugRow | null {
  return (
    db
      .query<SlugRow, [string, string, string]>(
        `SELECT id, scope, scope_key, slug_normalized, slug_display, state, subject_id,
                reserved_principal_type, reserved_principal_id, reserved_until
           FROM slugs
          WHERE scope = ? AND scope_key = ? AND slug_normalized = ?`,
      )
      .get(scope, scopeKey, slugNormalized) ?? null
  );
}

export function slugsForSubject(db: Db, scope: SlugScope, subjectId: string): SlugRow[] {
  return db
    .query<SlugRow, [string, string]>(
      `SELECT id, scope, scope_key, slug_normalized, slug_display, state, subject_id,
              reserved_principal_type, reserved_principal_id, reserved_until, claimed_at
         FROM slugs
        WHERE scope = ? AND subject_id = ? AND state = 'active'`,
    )
    .all(scope, subjectId);
}

function recordHistory(
  db: Db,
  slugId: number,
  event: "claimed" | "released" | "reclaimed" | "expired" | "transferred",
  subjectId: string | null,
  accountId: string | null,
  now: number,
): void {
  db.query(
    "INSERT INTO slug_history (slug_id, event, subject_id, account_id, at) VALUES (?,?,?,?,?)",
  ).run(slugId, event, subjectId, accountId, now);
}

/**
 * Moves an active slug into its reservation window.
 *
 * The reclaim right belongs to the SUBJECT — the system or member — not the
 * account that happened to hold it (decision 6). If a system changes hands, the
 * reclaim right goes with the system.
 *
 * The compare-and-swap on `state = 'active'` means a concurrent release cannot
 * double-fire and reset the reservation clock.
 */
export function releaseSlug(
  db: Db,
  slug: SlugRow,
  now: number,
  accountId: string | null = null,
): boolean {
  if (slug.state !== "active" || !slug.subject_id) return false;
  const principalType: PrincipalType = slug.scope;
  const result = db
    .query(
      `UPDATE slugs
          SET state = 'reserved',
              subject_id = NULL,
              reserved_principal_type = ?,
              reserved_principal_id = ?,
              reserved_until = ?,
              released_at = ?
        WHERE id = ? AND state = 'active'`,
    )
    .run(principalType, slug.subject_id, now + RESERVATION_MS, now, slug.id);

  if (Number(result.changes ?? 0) === 0) return false;
  recordHistory(db, slug.id, "released", slug.subject_id, accountId, now);
  return true;
}

/** Releases every active slug held by a subject. Used when a system is unclaimed. */
export function releaseSlugsForSubject(
  db: Db,
  scope: SlugScope,
  subjectId: string,
  now: number,
  accountId: string | null = null,
): number {
  let released = 0;
  for (const slug of slugsForSubject(db, scope, subjectId)) {
    if (releaseSlug(db, slug, now, accountId)) released += 1;
  }
  return released;
}

export type ReclaimResult =
  | { ok: true }
  | { ok: false; reason: "not_reserved" | "reserved_for_someone_else" | "expired" };

/**
 * Returns a reserved slug to its previous subject.
 *
 * The guard runs inside the UPDATE rather than as a prior SELECT, so a claim
 * arriving between the check and the write cannot slip through.
 */
export function reclaimSlug(
  db: Db,
  slug: SlugRow,
  subjectId: string,
  now: number,
  accountId: string | null = null,
): ReclaimResult {
  const state = effectiveState(slug, now);
  if (state.kind === "active") return { ok: false, reason: "not_reserved" };
  if (state.kind === "free") return { ok: false, reason: "expired" };
  if (state.principalId !== subjectId) {
    return { ok: false, reason: "reserved_for_someone_else" };
  }

  const result = db
    .query(
      `UPDATE slugs
          SET state = 'active',
              subject_id = ?,
              reserved_principal_type = NULL,
              reserved_principal_id = NULL,
              reserved_until = NULL,
              claimed_at = ?
        WHERE id = ?
          AND state = 'reserved'
          AND reserved_principal_id = ?
          AND reserved_until > ?`,
    )
    .run(subjectId, now, slug.id, subjectId, now);

  if (Number(result.changes ?? 0) === 0) return { ok: false, reason: "expired" };
  recordHistory(db, slug.id, "reclaimed", subjectId, accountId, now);
  return { ok: true };
}

/** Reclaims every slug still reserved for a subject. Used when a system is
 * re-claimed inside its grace window. */
export function reclaimSlugsForSubject(
  db: Db,
  scope: SlugScope,
  subjectId: string,
  now: number,
  accountId: string | null = null,
): number {
  const rows = db
    .query<SlugRow, [string, string]>(
      `SELECT id, scope, scope_key, slug_normalized, slug_display, state, subject_id,
              reserved_principal_type, reserved_principal_id, reserved_until
         FROM slugs
        WHERE scope = ? AND state = 'reserved' AND reserved_principal_id = ?`,
    )
    .all(scope, subjectId);

  let reclaimed = 0;
  for (const row of rows) {
    if (reclaimSlug(db, row, subjectId, now, accountId).ok) reclaimed += 1;
  }
  return reclaimed;
}

/**
 * Slugs still held in reservation for a subject, newest first.
 *
 * These are addresses this system or member released and can still take back.
 * Expiry is evaluated here against the clock rather than read from a state
 * column, so a lapsed reservation simply stops appearing.
 */
export function reservationsForSubject(
  db: Db,
  scope: SlugScope,
  subjectId: string,
  now: number,
): Array<{ slug: string; until: number }> {
  return db
    .query<SlugRow, [string, string]>(
      `SELECT id, scope, scope_key, slug_normalized, slug_display, state, subject_id,
              reserved_principal_type, reserved_principal_id, reserved_until
         FROM slugs
        WHERE scope = ? AND state = 'reserved' AND reserved_principal_id = ?
        ORDER BY reserved_until DESC`,
    )
    .all(scope, subjectId)
    .flatMap((row) => {
      const state = effectiveState(row, now);
      return state.kind === "reserved"
        ? [{ slug: row.slug_display, until: state.until }]
        : [];
    });
}
