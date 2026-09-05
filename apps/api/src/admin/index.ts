import { randomUUID } from "node:crypto";
import {
  isBadgeIcon,
  isBadgeTone,
  isRecognitionId,
  MAX_BADGE_DESCRIPTION_LENGTH,
  MAX_BADGE_LABEL_LENGTH,
  MAX_BADGE_NOTE_LENGTH,
  MAX_CREDIT_DETAIL_LENGTH,
  MAX_CREDIT_NAME_LENGTH,
  MAX_SECTION_DESCRIPTION_LENGTH,
  MAX_SECTION_LABEL_LENGTH,
  validateSocialUrl,
  type BadgeIconId,
  type BadgeState,
  type BadgeToneId,
  type CreditSection,
} from "@pkviewer/shared";
import type { Db } from "../db/index.ts";
import { writeTx } from "../db/index.ts";

/**
 * The administration plane.
 *
 * "Public users can use pkviewer; admins administer pkviewer." That sentence is
 * a permission boundary, and the schema enforces it rather than the code
 * remembering to: admin is a grant over the PLATFORM subject, while every
 * system-scoped check looks up a grant whose subject_id is that system's id. A
 * platform grant cannot satisfy a system lookup, so an admin gains no access to
 * anyone's system, theme, slug or social links. There is no code path here that
 * reads or writes another account's presentation data.
 *
 * What an admin can do is grant recognition and edit the credits page. Both are
 * platform-owned surfaces.
 */

export const PLATFORM_SUBJECT = "pkviewer";

/** True when this account holds the platform admin grant. */
export function isAdmin(db: Db, accountId: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT 1 AS n FROM grants
        WHERE account_id = ? AND subject_type = 'platform'
          AND subject_id = '${PLATFORM_SUBJECT}' AND role = 'admin'`,
    )
    .get(accountId);
  return row !== null && row !== undefined;
}

/**
 * Grants admin. Deliberately not reachable over HTTP.
 *
 * The first admin has to come from outside the application — there is nobody to
 * authorise it — so it is an operator action (`bun run admin:grant`) rather than
 * an environment variable that would silently make anyone holding a Discord id
 * an administrator of a running deployment.
 */
export function grantAdmin(db: Db, accountId: string, now: number, grantedBy?: string): void {
  writeTx(db, (tx) => {
    tx.query(
      `INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at, granted_by)
       VALUES (?, 'platform', ?, 'admin', ?, ?)
       ON CONFLICT (account_id, subject_type, subject_id) DO NOTHING`,
    ).run(accountId, PLATFORM_SUBJECT, now, grantedBy ?? null);
    audit(tx, now, grantedBy ?? null, "admin.grant", accountId, null);
  });
}

export function revokeAdmin(db: Db, accountId: string, now: number, revokedBy?: string): void {
  writeTx(db, (tx) => {
    tx.query(
      `DELETE FROM grants
        WHERE account_id = ? AND subject_type = 'platform' AND subject_id = ? AND role = 'admin'`,
    ).run(accountId, PLATFORM_SUBJECT);
    audit(tx, now, revokedBy ?? null, "admin.revoke", accountId, null);
  });
}

export function listAdmins(db: Db): { accountId: string; grantedAt: number }[] {
  return db
    .query<{ account_id: string; granted_at: number }, []>(
      `SELECT account_id, granted_at FROM grants
        WHERE subject_type = 'platform' AND role = 'admin' ORDER BY granted_at`,
    )
    .all()
    .map((r) => ({ accountId: r.account_id, grantedAt: r.granted_at }));
}

function audit(
  db: Db,
  at: number,
  accountId: string | null,
  action: string,
  target: string | null,
  detail: unknown,
): void {
  db.query(
    "INSERT INTO audit_events (at, account_id, action, target, detail) VALUES (?,?,?,?,?)",
  ).run(at, accountId, action, target, detail === null ? null : JSON.stringify(detail));
}

// ------------------------------------------------------------------ badges --

export type BadgeRow = {
  id: string;
  label: string;
  description: string;
  icon: BadgeIconId;
  tone: BadgeToneId;
  sortOrder: number;
  retiredAt: number | null;
  /**
   * Whether this badge waits for its recipient before appearing.
   *
   * True for everything except PK Dev; see migration 007 for why that one is
   * different and why this is not editable over HTTP.
   */
  consentRequired: boolean;
};

type RawBadge = {
  id: string;
  label: string;
  description: string;
  icon: string;
  tone: string;
  sort_order: number;
  retired_at: number | null;
  consent_required: number;
};

/**
 * Reads the catalogue, discarding rows whose icon or tone is not in the
 * code-defined list.
 *
 * A row can only acquire an unknown key through a hand-edited database or a
 * future catalogue change, and rendering an unknown key would either crash the
 * page or fall through to unstyled markup. Dropping it keeps a public page
 * working, which matters more than showing every badge.
 */
function toBadgeRow(r: RawBadge): BadgeRow | null {
  if (!isBadgeIcon(r.icon) || !isBadgeTone(r.tone)) return null;
  return {
    id: r.id,
    label: r.label,
    description: r.description,
    icon: r.icon,
    tone: r.tone,
    sortOrder: r.sort_order,
    retiredAt: r.retired_at,
    consentRequired: r.consent_required !== 0,
  };
}

export function listBadges(db: Db, opts: { includeRetired?: boolean } = {}): BadgeRow[] {
  const rows = db
    .query<RawBadge, []>(
      `SELECT id, label, description, icon, tone, sort_order, retired_at, consent_required
         FROM badges ORDER BY sort_order, id`,
    )
    .all();
  return rows
    .map(toBadgeRow)
    .filter((b): b is BadgeRow => b !== null && (opts.includeRetired === true || b.retiredAt === null));
}

export type BadgeInput = {
  id: string;
  label: string;
  description: string;
  icon: string;
  tone: string;
  sortOrder?: number;
};

export type SaveFailure = { field: string; reason: string };

function textField(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): { ok: true; value: string | null } | { ok: false; failure: SaveFailure } {
  if (value === null || value === undefined || value === "") {
    if (required) return { ok: false, failure: { field, reason: "required" } };
    return { ok: true, value: null };
  }
  if (typeof value !== "string") return { ok: false, failure: { field, reason: "not_text" } };
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) return { ok: false, failure: { field, reason: "required" } };
    return { ok: true, value: null };
  }
  if (trimmed.length > max) return { ok: false, failure: { field, reason: "too_long" } };
  return { ok: true, value: trimmed };
}

/**
 * Creates or updates a catalogue entry.
 *
 * Validate-then-write, all or nothing (M3): a rejected field never leaves the
 * row half-updated.
 */
export function saveBadge(
  db: Db,
  input: BadgeInput,
  now: number,
): { ok: true; badge: BadgeRow } | { ok: false; failures: SaveFailure[] } {
  const failures: SaveFailure[] = [];

  if (!isRecognitionId(input.id)) failures.push({ field: "id", reason: "invalid" });
  if (!isBadgeIcon(input.icon)) failures.push({ field: "icon", reason: "not_allowed" });
  if (!isBadgeTone(input.tone)) failures.push({ field: "tone", reason: "not_allowed" });

  const label = textField(input.label, "label", MAX_BADGE_LABEL_LENGTH, true);
  if (!label.ok) failures.push(label.failure);
  const description = textField(
    input.description,
    "description",
    MAX_BADGE_DESCRIPTION_LENGTH,
    true,
  );
  if (!description.ok) failures.push(description.failure);

  if (failures.length > 0 || !label.ok || !description.ok) {
    return { ok: false, failures };
  }

  const sortOrder = Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0;
  writeTx(db, (tx) => {
    tx.query(
      // consent_required is absent from both the insert and the update: a new
      // badge gets the column default (consent required), and editing an
      // existing one cannot change it. See migration 007.
      `INSERT INTO badges (id, label, description, icon, tone, sort_order, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label,
         description = excluded.description,
         icon = excluded.icon,
         tone = excluded.tone,
         sort_order = excluded.sort_order`,
    ).run(
      input.id,
      label.value,
      description.value,
      input.icon,
      input.tone,
      sortOrder,
      now,
    );
  });

  const saved = listBadges(db, { includeRetired: true }).find((b) => b.id === input.id);
  return saved ? { ok: true, badge: saved } : { ok: false, failures: [{ field: "id", reason: "not_saved" }] };
}

/**
 * Retires a badge rather than deleting it.
 *
 * Rows already granted keep rendering — removing a badge from someone's page
 * because the catalogue was tidied would be a worse surprise than a badge that
 * can no longer be handed out.
 */
export function retireBadge(db: Db, badgeId: string, now: number, byAccount: string): boolean {
  const changed = writeTx(db, (tx) => {
    const res = tx.query("UPDATE badges SET retired_at = ? WHERE id = ? AND retired_at IS NULL")
      .run(now, badgeId);
    if (res.changes > 0) audit(tx, now, byAccount, "badge.retire", badgeId, null);
    return res.changes > 0;
  });
  return changed;
}

export function restoreBadge(db: Db, badgeId: string, now: number, byAccount: string): boolean {
  return writeTx(db, (tx) => {
    const res = tx.query("UPDATE badges SET retired_at = NULL WHERE id = ?").run(badgeId);
    if (res.changes > 0) audit(tx, now, byAccount, "badge.restore", badgeId, null);
    return res.changes > 0;
  });
}

// -------------------------------------------------------------- assignment --

export type Assignment = {
  id: number;
  subjectType: "system" | "member";
  subjectId: string;
  badgeId: string;
  badgeLabel: string;
  state: BadgeState;
  note: string | null;
  grantedAt: number;
  grantedBy: string | null;
  respondedAt: number | null;
  revokedAt: number | null;
  /** PluralKit HID of the subject system, for display in the admin list. */
  systemHid: string | null;
  /** Current pkviewer address, when the subject has one. */
  slug: string | null;
};

const ASSIGNMENT_SELECT = `
  SELECT sb.id, sb.subject_type, sb.subject_id, sb.badge_id, b.label AS badge_label,
         sb.state, sb.note, sb.granted_at, sb.granted_by, sb.responded_at, sb.revoked_at,
         s.pk_system_hid AS system_hid,
         (SELECT sl.slug_display FROM slugs sl
           WHERE sl.scope = 'system' AND sl.state = 'active' AND sl.subject_id = sb.subject_id
           LIMIT 1) AS slug
    FROM subject_badges sb
    JOIN badges b ON b.id = sb.badge_id
    LEFT JOIN systems s ON s.id = sb.subject_id AND sb.subject_type = 'system'
`;

type RawAssignment = {
  id: number;
  subject_type: string;
  subject_id: string;
  badge_id: string;
  badge_label: string;
  state: string;
  note: string | null;
  granted_at: number;
  granted_by: string | null;
  responded_at: number | null;
  revoked_at: number | null;
  system_hid: string | null;
  slug: string | null;
};

function toAssignment(r: RawAssignment): Assignment {
  return {
    id: r.id,
    subjectType: r.subject_type as "system" | "member",
    subjectId: r.subject_id,
    badgeId: r.badge_id,
    badgeLabel: r.badge_label,
    state: r.state as BadgeState,
    note: r.note,
    grantedAt: r.granted_at,
    grantedBy: r.granted_by,
    respondedAt: r.responded_at,
    revokedAt: r.revoked_at,
    systemHid: r.system_hid,
    slug: r.slug,
  };
}

/**
 * Whether a badge may be granted to a system that has never used pkviewer.
 *
 * Only badges that need no answer. Granting a consent-required badge to a
 * system with no account produces an offer nobody can ever receive, which is a
 * worse outcome than refusing: it looks granted in the admin list and is
 * invisible everywhere else, forever.
 */
export function badgeNeedsNoConsent(db: Db, badgeId: string): boolean {
  const row = db
    .query<{ consent_required: number }, [string]>(
      "SELECT consent_required FROM badges WHERE id = ? AND retired_at IS NULL",
    )
    .get(badgeId);
  return row !== null && row !== undefined && row.consent_required === 0;
}

export function listAssignments(db: Db, state?: BadgeState): Assignment[] {
  const rows = state
    ? db.query<RawAssignment, [string]>(`${ASSIGNMENT_SELECT} WHERE sb.state = ? ORDER BY sb.granted_at DESC`).all(state)
    : db.query<RawAssignment, []>(`${ASSIGNMENT_SELECT} ORDER BY sb.granted_at DESC`).all();
  return rows.map(toAssignment);
}

export type GrantFailure =
  | "unknown_badge"
  | "badge_retired"
  | "unknown_subject"
  | "invalid_note";

/**
 * Grants a badge to a system.
 *
 * `autoAccept` is passed by the route when the granting admin also manages the
 * subject — granting yourself the Owner badge needs no consent dance, because
 * consent is the point of the offer and you are the person consenting. Every
 * other grant starts `pending`.
 */
export function grantBadge(
  db: Db,
  input: {
    subjectId: string;
    badgeId: string;
    note?: unknown;
    byAccount: string;
    autoAccept: boolean;
  },
  now: number,
): { ok: true; assignment: Assignment } | { ok: false; reason: GrantFailure } {
  const badge = db
    .query<{ id: string; retired_at: number | null; consent_required: number }, [string]>(
      "SELECT id, retired_at, consent_required FROM badges WHERE id = ?",
    )
    .get(input.badgeId);
  if (!badge) return { ok: false, reason: "unknown_badge" };
  if (badge.retired_at !== null) return { ok: false, reason: "badge_retired" };

  const subject = db
    .query<{ id: string }, [string]>("SELECT id FROM systems WHERE id = ?")
    .get(input.subjectId);
  if (!subject) return { ok: false, reason: "unknown_subject" };

  const note = textField(input.note, "note", MAX_BADGE_NOTE_LENGTH, false);
  if (!note.ok) return { ok: false, reason: "invalid_note" };

  // Accepted on arrival in two cases: the badge does not require consent
  // (migration 007), or the granting admin is the subject's own manager, in
  // which case the person consenting and the person granting are the same.
  const accepted = badge.consent_required === 0 || input.autoAccept;
  const state: BadgeState = accepted ? "accepted" : "pending";

  const id = writeTx(db, (tx) => {
    tx.query(
      `INSERT INTO subject_badges
         (subject_type, subject_id, badge_id, state, note, granted_at, granted_by, responded_at)
       VALUES ('system', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (subject_type, subject_id, badge_id) DO UPDATE SET
         state = excluded.state,
         note = excluded.note,
         granted_at = excluded.granted_at,
         granted_by = excluded.granted_by,
         responded_at = excluded.responded_at,
         revoked_at = NULL,
         revoked_by = NULL`,
    ).run(
      input.subjectId,
      input.badgeId,
      state,
      note.value,
      now,
      input.byAccount,
      accepted ? now : null,
    );
    audit(tx, now, input.byAccount, "badge.grant", input.subjectId, {
      badge: input.badgeId,
      state,
    });
    return tx
      .query<{ id: number }, [string, string]>(
        "SELECT id FROM subject_badges WHERE subject_id = ? AND badge_id = ?",
      )
      .get(input.subjectId, input.badgeId)?.id ?? 0;
  });

  const assignment = listAssignments(db).find((a) => a.id === id);
  return assignment
    ? { ok: true, assignment }
    : { ok: false, reason: "unknown_subject" };
}

export function revokeBadge(
  db: Db,
  assignmentId: number,
  now: number,
  byAccount: string,
): boolean {
  return writeTx(db, (tx) => {
    const row = tx
      .query<{ subject_id: string; badge_id: string }, [number]>(
        "SELECT subject_id, badge_id FROM subject_badges WHERE id = ?",
      )
      .get(assignmentId);
    if (!row) return false;
    tx.query(
      "UPDATE subject_badges SET state = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?",
    ).run(now, byAccount, assignmentId);
    audit(tx, now, byAccount, "badge.revoke", row.subject_id, { badge: row.badge_id });
    return true;
  });
}

// ----------------------------------------------------------------- credits --

export type CreditRow = {
  id: string;
  sectionId: string;
  name: string;
  detail: string | null;
  url: string | null;
  sortOrder: number;
  visible: boolean;
};

export type SectionRow = {
  id: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

export function listSections(db: Db): SectionRow[] {
  return db
    .query<{ id: string; label: string; description: string | null; sort_order: number }, []>(
      "SELECT id, label, description, sort_order FROM credit_sections ORDER BY sort_order, id",
    )
    .all()
    .map((r) => ({ id: r.id, label: r.label, description: r.description, sortOrder: r.sort_order }));
}

export function listCredits(db: Db, opts: { includeHidden?: boolean } = {}): CreditRow[] {
  const rows = db
    .query<
      {
        id: string;
        section_id: string;
        name: string;
        detail: string | null;
        url: string | null;
        sort_order: number;
        visible: number;
      },
      []
    >(
      `SELECT id, section_id, name, detail, url, sort_order, visible
         FROM credits ORDER BY sort_order, name`,
    )
    .all();
  return rows
    .filter((r) => opts.includeHidden === true || r.visible === 1)
    .map((r) => ({
      id: r.id,
      sectionId: r.section_id,
      name: r.name,
      detail: r.detail,
      url: r.url,
      sortOrder: r.sort_order,
      visible: r.visible === 1,
    }));
}

/** The credits page, already grouped. Empty sections are omitted. */
export function buildCreditsPage(db: Db): CreditSection[] {
  const credits = listCredits(db);
  return listSections(db)
    .map((section) => ({
      id: section.id,
      label: section.label,
      description: section.description,
      entries: credits
        .filter((c) => c.sectionId === section.id)
        .map((c) => ({ id: c.id, name: c.name, detail: c.detail, url: c.url })),
    }))
    .filter((s) => s.entries.length > 0);
}

export type CreditInput = {
  id?: string;
  sectionId: string;
  name: unknown;
  detail?: unknown;
  url?: unknown;
  sortOrder?: number;
  visible?: boolean;
};

export function saveCredit(
  db: Db,
  input: CreditInput,
  now: number,
  byAccount: string,
): { ok: true; id: string } | { ok: false; failures: SaveFailure[] } {
  const failures: SaveFailure[] = [];

  const section = db
    .query<{ id: string }, [string]>("SELECT id FROM credit_sections WHERE id = ?")
    .get(input.sectionId);
  if (!section) failures.push({ field: "sectionId", reason: "unknown" });

  const name = textField(input.name, "name", MAX_CREDIT_NAME_LENGTH, true);
  if (!name.ok) failures.push(name.failure);
  const detail = textField(input.detail, "detail", MAX_CREDIT_DETAIL_LENGTH, false);
  if (!detail.ok) failures.push(detail.failure);

  // Same rule as a social link: http(s) only, rendered as a link, never fetched.
  let url: string | null = null;
  if (input.url !== null && input.url !== undefined && input.url !== "") {
    const checked = validateSocialUrl(input.url);
    if (!checked.ok) failures.push({ field: "url", reason: checked.reason });
    else url = checked.url;
  }

  if (failures.length > 0 || !name.ok || !detail.ok) return { ok: false, failures };

  const id = input.id ?? randomUUID();
  const sortOrder = Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0;
  const visible = input.visible === false ? 0 : 1;

  writeTx(db, (tx) => {
    tx.query(
      `INSERT INTO credits
         (id, section_id, name, detail, url, sort_order, visible, created_at, updated_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET
         section_id = excluded.section_id,
         name = excluded.name,
         detail = excluded.detail,
         url = excluded.url,
         sort_order = excluded.sort_order,
         visible = excluded.visible,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      input.sectionId,
      name.value,
      detail.value,
      url,
      sortOrder,
      visible,
      now,
      now,
      byAccount,
    );
    audit(tx, now, byAccount, input.id ? "credit.update" : "credit.create", id, {
      section: input.sectionId,
    });
  });

  return { ok: true, id };
}

export function deleteCredit(db: Db, id: string, now: number, byAccount: string): boolean {
  return writeTx(db, (tx) => {
    const res = tx.query("DELETE FROM credits WHERE id = ?").run(id);
    if (res.changes > 0) audit(tx, now, byAccount, "credit.delete", id, null);
    return res.changes > 0;
  });
}

export type SectionInput = {
  id: string;
  label: unknown;
  description?: unknown;
  sortOrder?: number;
};

export function saveSection(
  db: Db,
  input: SectionInput,
  now: number,
  byAccount: string,
): { ok: true } | { ok: false; failures: SaveFailure[] } {
  const failures: SaveFailure[] = [];
  if (!isRecognitionId(input.id)) failures.push({ field: "id", reason: "invalid" });
  const label = textField(input.label, "label", MAX_SECTION_LABEL_LENGTH, true);
  if (!label.ok) failures.push(label.failure);
  const description = textField(
    input.description,
    "description",
    MAX_SECTION_DESCRIPTION_LENGTH,
    false,
  );
  if (!description.ok) failures.push(description.failure);
  if (failures.length > 0 || !label.ok || !description.ok) {
    return { ok: false, failures };
  }

  writeTx(db, (tx) => {
    tx.query(
      `INSERT INTO credit_sections (id, label, description, sort_order, created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label,
         description = excluded.description,
         sort_order = excluded.sort_order`,
    ).run(
      input.id,
      label.value,
      description.value,
      Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0,
      now,
    );
    audit(tx, now, byAccount, "credit.section.save", input.id, null);
  });
  return { ok: true };
}

/**
 * Deletes a section. Refuses while it still holds credits.
 *
 * The foreign key is RESTRICT, so this reports the situation rather than
 * surfacing a constraint error — and never silently deletes someone's credit
 * along with the section.
 */
export function deleteSection(
  db: Db,
  id: string,
  now: number,
  byAccount: string,
): { ok: true } | { ok: false; reason: "not_empty" | "not_found" } {
  const count = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM credits WHERE section_id = ?")
    .get(id)?.n ?? 0;
  if (count > 0) return { ok: false, reason: "not_empty" };
  return writeTx(db, (tx) => {
    const res = tx.query("DELETE FROM credit_sections WHERE id = ?").run(id);
    if (res.changes === 0) return { ok: false as const, reason: "not_found" as const };
    audit(tx, now, byAccount, "credit.section.delete", id, null);
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------- audit --

export type AuditEntry = {
  at: number;
  accountId: string | null;
  action: string;
  target: string | null;
  detail: string | null;
};

/** Recent recognition activity, for the admin panel's history view. */
export function listRecognitionAudit(db: Db, limit = 100): AuditEntry[] {
  return db
    .query<
      { at: number; account_id: string | null; action: string; target: string | null; detail: string | null },
      [number]
    >(
      `SELECT at, account_id, action, target, detail FROM audit_events
        WHERE action LIKE 'badge.%' OR action LIKE 'credit.%' OR action LIKE 'admin.%'
        ORDER BY at DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({
      at: r.at,
      accountId: r.account_id,
      action: r.action,
      target: r.target,
      detail: r.detail,
    }));
}
