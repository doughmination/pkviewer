import type { Db } from "../db/index.ts";
import { writeTx } from "../db/index.ts";
import {
  effectiveState,
  findSlug,
  releaseSlug,
  slugsForSubject,
  type SlugRow,
  RESERVATION_MS,
} from "./lifecycle.ts";
import { looksLikeHid, validateSlug, type SlugRejection, type SlugScope } from "./normalize.ts";

/**
 * Slug claiming.
 *
 * The race safety story is the same one used for system ownership: uniqueness
 * and state transitions are enforced by the database, never by a read followed
 * by a decision followed by a write.
 *
 *  - A brand new slug is a single INSERT guarded by
 *    `UNIQUE (scope, scope_key, slug_normalized)`.
 *  - Taking over a reserved-but-lapsed slug, or reclaiming one, is an UPDATE
 *    whose WHERE clause re-asserts every precondition, checked via `changes()`.
 *
 * Two simultaneous claimants therefore cannot both win: the loser either hits
 * the constraint or updates zero rows, and reports a conflict.
 */

export type ClaimSlugFailure =
  | { kind: "invalid"; reason: SlugRejection }
  | { kind: "taken" }
  | { kind: "reserved"; until: number }
  | { kind: "conflict" };

export type ClaimSlugSuccess = {
  kind: "claimed" | "reclaimed" | "unchanged";
  slug: string;
  previousSlug: string | null;
  /** Non-blocking advisories, e.g. shadowing one of your own member ids. */
  warnings: SlugWarning[];
};

export type SlugWarning =
  | { code: "shadows_member_id"; memberHid: string }
  | { code: "previous_slug_reserved"; slug: string; until: number };

export type ClaimSlugResult =
  | ({ ok: true } & ClaimSlugSuccess)
  | ({ ok: false } & ClaimSlugFailure);

export type ClaimSlugParams = {
  scope: SlugScope;
  /** '' for system slugs (global); the owning system id for member slugs. */
  scopeKey: string;
  subjectId: string;
  requested: string;
  accountId: string | null;
  now: number;
  /**
   * Short ids of other members in the same system, when claiming a member slug.
   *
   * Used only to warn: a member slug that matches a sibling's id shadows that
   * sibling's id URL. It is contained inside one system the claimant already
   * controls, so it is advisory rather than forbidden.
   */
  siblingHids?: readonly string[];
};

export function claimSlug(db: Db, params: ClaimSlugParams): ClaimSlugResult {
  const validation = validateSlug(params.requested, params.scope);
  if (!validation.ok) return { ok: false, kind: "invalid", reason: validation.reason };

  const { normalized, display } = validation;
  const warnings: SlugWarning[] = [];

  if (params.scope === "member" && looksLikeHid(normalized)) {
    const clash = params.siblingHids?.find((hid) => hid.toLowerCase() === normalized);
    if (clash) warnings.push({ code: "shadows_member_id", memberHid: clash });
  }

  return writeTx(db, (tx) => {
    const existing = findSlug(tx, params.scope, params.scopeKey, normalized);

    // Already ours and active: nothing to do, and no reservation churn.
    if (existing) {
      const state = effectiveState(existing, params.now);
      if (state.kind === "active" && state.subjectId === params.subjectId) {
        return { ok: true, kind: "unchanged", slug: display, previousSlug: null, warnings };
      }
      if (state.kind === "active") return { ok: false, kind: "taken" };
      if (state.kind === "reserved" && state.principalId !== params.subjectId) {
        // Never say who holds the reservation.
        return { ok: false, kind: "reserved", until: state.until };
      }
    }

    // A subject holds at most one active slug per scope. Claiming a new one
    // releases the old into its own 7-day reservation rather than freeing it
    // immediately, so a rename cannot be used to snipe someone's old URL and
    // the owner can change their mind.
    const previous = slugsForSubject(tx, params.scope, params.subjectId).find(
      (row) => row.slug_normalized !== normalized,
    );
    let previousSlug: string | null = null;
    if (previous) {
      if (releaseSlug(tx, previous, params.now, params.accountId)) {
        previousSlug = previous.slug_display;
        warnings.push({
          code: "previous_slug_reserved",
          slug: previous.slug_display,
          until: params.now + RESERVATION_MS,
        });
      }
    }

    if (!existing) {
      try {
        tx.query(
          `INSERT INTO slugs
             (scope, scope_key, slug_normalized, slug_display, state, subject_id, claimed_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        ).run(params.scope, params.scopeKey, normalized, display, params.subjectId, params.now);
      } catch {
        // The unique index fired: another claimant got there first.
        return { ok: false, kind: "conflict" };
      }
      recordHistory(tx, params.scope, params.scopeKey, normalized, "claimed", params);
      return { ok: true, kind: "claimed", slug: display, previousSlug, warnings };
    }

    // Reserved for us, or lapsed and free. Both preconditions are re-asserted
    // in the WHERE clause so a concurrent claim cannot slip between the read
    // above and this write.
    const isOurReservation =
      existing.state === "reserved" && existing.reserved_principal_id === params.subjectId;

    const result = tx
      .query(
        `UPDATE slugs
            SET state = 'active',
                subject_id = ?,
                slug_display = ?,
                reserved_principal_type = NULL,
                reserved_principal_id = NULL,
                reserved_until = NULL,
                claimed_at = ?
          WHERE id = ?
            AND state = 'reserved'
            AND (reserved_principal_id = ? OR reserved_until <= ?)`,
      )
      .run(params.subjectId, display, params.now, existing.id, params.subjectId, params.now);

    if (Number(result.changes ?? 0) === 0) return { ok: false, kind: "conflict" };

    recordHistory(
      tx,
      params.scope,
      params.scopeKey,
      normalized,
      isOurReservation ? "reclaimed" : "claimed",
      params,
    );

    return {
      ok: true,
      kind: isOurReservation ? "reclaimed" : "claimed",
      slug: display,
      previousSlug,
      warnings,
    };
  });
}

function recordHistory(
  db: Db,
  scope: SlugScope,
  scopeKey: string,
  normalized: string,
  event: "claimed" | "reclaimed",
  params: ClaimSlugParams,
): void {
  const row = findSlug(db, scope, scopeKey, normalized);
  if (!row) return;
  db.query(
    "INSERT INTO slug_history (slug_id, event, subject_id, account_id, at) VALUES (?,?,?,?,?)",
  ).run(row.id, event, params.subjectId, params.accountId, params.now);
}

export type SlugAvailability =
  | { available: true }
  | { available: false; reason: "invalid"; detail: SlugRejection }
  | { available: false; reason: "taken" }
  | { available: false; reason: "reserved"; until: number }
  | { available: true; reason: "yours" };

/**
 * Availability for a live-checking UI.
 *
 * Advisory only: availability can change between this call and a claim, which
 * is why the claim path re-checks everything transactionally rather than
 * trusting an earlier answer.
 */
export function checkSlugAvailability(
  db: Db,
  params: { scope: SlugScope; scopeKey: string; subjectId?: string; requested: string; now: number },
): SlugAvailability {
  const validation = validateSlug(params.requested, params.scope);
  if (!validation.ok) {
    return { available: false, reason: "invalid", detail: validation.reason };
  }

  const existing = findSlug(db, params.scope, params.scopeKey, validation.normalized);
  if (!existing) return { available: true };

  const state = effectiveState(existing, params.now);
  switch (state.kind) {
    case "free":
      return { available: true };
    case "active":
      return state.subjectId === params.subjectId
        ? { available: true, reason: "yours" }
        : { available: false, reason: "taken" };
    case "reserved":
      return state.principalId === params.subjectId
        ? { available: true, reason: "yours" }
        : { available: false, reason: "reserved", until: state.until };
  }
}

/** The active slug for a subject, if any. */
export function activeSlugFor(db: Db, scope: SlugScope, subjectId: string): SlugRow | null {
  return slugsForSubject(db, scope, subjectId)[0] ?? null;
}
