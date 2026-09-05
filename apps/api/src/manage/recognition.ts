import {
  isBadgeIcon,
  isBadgeTone,
  type BadgeState,
  type OfferedBadge,
  type PublicBadge,
} from "@pkviewer/shared";
import type { Db } from "../db/index.ts";
import { writeTx } from "../db/index.ts";

/**
 * The recipient's side of a badge.
 *
 * Granting is an admin action; showing is not. A badge appears on someone's own
 * page and describes them to their visitors, so the system's manager decides
 * whether it is displayed. `accepted` is the only state that reaches a public
 * page, and that filter lives in ONE query (`publicBadgesFor`) so a new caller
 * cannot accidentally render a pending or revoked offer.
 */

type RawBadgeJoin = {
  badge_id: string;
  label: string;
  description: string;
  icon: string;
  tone: string;
  state: string;
  note: string | null;
  granted_at: number;
};

function toPublic(r: RawBadgeJoin): PublicBadge | null {
  if (!isBadgeIcon(r.icon) || !isBadgeTone(r.tone)) return null;
  return {
    id: r.badge_id,
    label: r.label,
    description: r.description,
    icon: r.icon,
    tone: r.tone,
  };
}

/**
 * Badges shown on a public page.
 *
 * Accepted only. `hidden`, `pending`, `declined` and `revoked` are all absent,
 * and a hidden badge is indistinguishable from one that was never granted —
 * hiding should not leave a visible gap that invites speculation.
 */
export function publicBadgesFor(db: Db, systemId: string | null): PublicBadge[] {
  if (!systemId) return [];
  return db
    .query<RawBadgeJoin, [string]>(
      `SELECT sb.badge_id, b.label, b.description, b.icon, b.tone, sb.state, sb.note, sb.granted_at
         FROM subject_badges sb
         JOIN badges b ON b.id = sb.badge_id
        WHERE sb.subject_type = 'system' AND sb.subject_id = ? AND sb.state = 'accepted'
        ORDER BY b.sort_order, b.id`,
    )
    .all(systemId)
    .map(toPublic)
    .filter((b): b is PublicBadge => b !== null);
}

/** Every badge offered to this system, in any state, for the management UI. */
export function offeredBadgesFor(db: Db, systemId: string): OfferedBadge[] {
  return db
    .query<RawBadgeJoin, [string]>(
      `SELECT sb.badge_id, b.label, b.description, b.icon, b.tone, sb.state, sb.note, sb.granted_at
         FROM subject_badges sb
         JOIN badges b ON b.id = sb.badge_id
        WHERE sb.subject_type = 'system' AND sb.subject_id = ? AND sb.state != 'revoked'
        ORDER BY b.sort_order, b.id`,
    )
    .all(systemId)
    .map((r) => {
      const base = toPublic(r);
      if (!base) return null;
      return {
        ...base,
        state: r.state as BadgeState,
        note: r.note,
        grantedAt: r.granted_at,
      };
    })
    .filter((b): b is OfferedBadge => b !== null);
}

export type RespondAction = "accept" | "decline" | "hide" | "show";

/**
 * Which states a recipient may move a badge between.
 *
 * Written as a table rather than as branching so the illegal transitions are
 * visible: nothing here can reach `revoked`, which is an admin-only state, and
 * a declined badge is not silently re-offered by an accept.
 */
const TRANSITIONS: Record<RespondAction, { from: BadgeState[]; to: BadgeState }> = {
  accept: { from: ["pending", "declined"], to: "accepted" },
  decline: { from: ["pending", "accepted", "hidden"], to: "declined" },
  hide: { from: ["accepted"], to: "hidden" },
  show: { from: ["hidden"], to: "accepted" },
};

export type RespondFailure = "not_found" | "not_allowed";

export function respondToBadge(
  db: Db,
  systemId: string,
  badgeId: string,
  action: RespondAction,
  now: number,
  byAccount: string,
): { ok: true; state: BadgeState } | { ok: false; reason: RespondFailure } {
  const transition = TRANSITIONS[action];
  if (!transition) return { ok: false, reason: "not_allowed" };

  const row = db
    .query<{ id: number; state: string }, [string, string]>(
      `SELECT id, state FROM subject_badges
        WHERE subject_type = 'system' AND subject_id = ? AND badge_id = ?`,
    )
    .get(systemId, badgeId);
  if (!row) return { ok: false, reason: "not_found" };

  // A revoked badge is gone as far as its recipient is concerned; reporting
  // not_found rather than not_allowed avoids confirming it ever existed.
  if (row.state === "revoked") return { ok: false, reason: "not_found" };
  if (!transition.from.includes(row.state as BadgeState)) {
    return { ok: false, reason: "not_allowed" };
  }

  writeTx(db, (tx) => {
    tx.query("UPDATE subject_badges SET state = ?, responded_at = ? WHERE id = ?").run(
      transition.to,
      now,
      row.id,
    );
    tx.query(
      "INSERT INTO audit_events (at, account_id, action, target, detail) VALUES (?,?,?,?,?)",
    ).run(now, byAccount, `badge.${action}`, systemId, JSON.stringify({ badge: badgeId }));
  });

  return { ok: true, state: transition.to };
}
