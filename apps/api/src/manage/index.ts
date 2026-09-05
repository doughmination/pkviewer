import { randomUUID } from "node:crypto";
import {
  MAX_SOCIAL_LABEL_LENGTH,
  MAX_SOCIAL_LINKS,
  SOCIAL_PLATFORM_IDS,
  sanitizeComposition,
  sanitizeTheme,
  validateSocialUrl,
  type SocialUrlFailure,
  type ValidationFailure,
} from "@pkviewer/shared";
import { accountManagesSystem } from "../claims/index.ts";
import type { Db } from "../db/index.ts";
import { writeTx } from "../db/index.ts";
import type { PkClient } from "../pk/client.ts";
import { PkError } from "../pk/errors.ts";
import type { PkMember, PkSystem } from "../pk/types.ts";
import { activeSlugFor } from "../slugs/claim.ts";

/**
 * Management-plane data access.
 *
 * The server stays authoritative for everything that matters: which systems an
 * account may touch, what a valid theme is, and what inheritance means. The
 * management client is a view over this, never a source of truth.
 */

export type ManageDeps = { db: Db; pk: PkClient; now?: () => number };

export type ManagedSystem = {
  systemId: string;
  pkSystemHid: string;
  role: string;
  name: string | null;
  avatarUrl: string | null;
  slug: string | null;
  /** Path on the public origin, composed at render time and never stored. */
  publicPath: string;
  memberCount: number | null;
  /** Age of the PluralKit snapshot in ms, or null when never fetched. */
  snapshotAgeMs: number | null;
  reachable: boolean;
};

/** Systems this account may manage, enriched with public PluralKit identity. */
export async function listManagedSystems(
  deps: ManageDeps,
  accountId: string,
): Promise<ManagedSystem[]> {
  const rows = deps.db
    .query<
      { subject_id: string; pk_system_hid: string; pk_system_uuid: string; role: string },
      [string]
    >(
      `SELECT g.subject_id AS subject_id, s.pk_system_hid AS pk_system_hid,
              s.pk_system_uuid AS pk_system_uuid, g.role AS role
         FROM grants g
         JOIN systems s ON s.id = g.subject_id
        WHERE g.account_id = ? AND g.subject_type = 'system'
        ORDER BY g.granted_at`,
    )
    .all(accountId);

  const out: ManagedSystem[] = [];
  for (const row of rows) {
    const slug = activeSlugFor(deps.db, "system", row.subject_id)?.slug_display ?? null;

    let system: PkSystem | null = null;
    let members: PkMember[] | null = null;
    try {
      system = await deps.pk.getSystem(row.pk_system_uuid);
      members = await deps.pk.getMembers(row.pk_system_uuid);
    } catch (err) {
      // PluralKit being unreachable must not empty the dashboard. The row still
      // appears, marked unreachable, with whatever we already knew.
      if (!(err instanceof PkError)) throw err;
    }

    out.push({
      systemId: row.subject_id,
      pkSystemHid: system?.id ?? row.pk_system_hid,
      role: row.role,
      name: system?.name ?? null,
      avatarUrl: system?.avatar_url ?? null,
      slug,
      publicPath: `/s/${slug ?? system?.id ?? row.pk_system_hid}`,
      memberCount: members?.length ?? null,
      snapshotAgeMs: deps.pk.snapshotAge("system", row.pk_system_uuid),
      reachable: system !== null,
    });
  }
  return out;
}

export type SystemRow = { id: string; pk_system_uuid: string; pk_system_hid: string };

/**
 * Loads a system only if this account may manage it.
 *
 * Every management read and write goes through this. Authorization is a
 * property of the request, checked server-side against the grants table; the
 * client is never trusted to have checked it.
 */
export function authorizeSystem(db: Db, accountId: string, systemId: string): SystemRow | null {
  if (!accountManagesSystem(db, accountId, systemId)) return null;
  return (
    db
      .query<SystemRow, [string]>(
        "SELECT id, pk_system_uuid, pk_system_hid FROM systems WHERE id = ?",
      )
      .get(systemId) ?? null
  );
}

// ------------------------------------------------------------------- themes

export type StoredTheme = { tokens: unknown; composition: unknown };

export function readTheme(db: Db, ownerType: "system" | "member", ownerId: string): StoredTheme {
  const row = db
    .query<{ tokens: string; composition: string }, [string, string]>(
      `SELECT tokens, composition FROM themes
        WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
    )
    .get(ownerType, ownerId);
  if (!row) return { tokens: {}, composition: {} };
  return { tokens: safeParse(row.tokens), composition: safeParse(row.composition) };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export type SaveThemeResult =
  | { ok: true }
  | { ok: false; reason: "invalid"; rejected: Array<{ key: string; reason: ValidationFailure }> };

/**
 * Writes a theme.
 *
 * Two properties worth stating because both are easy to get wrong:
 *
 *  - The incoming blob replaces only the layer it names. Tokens and composition
 *    are written independently, so saving appearance can never silently wipe
 *    directory settings.
 *  - Every value is revalidated here. The client's validation is a convenience;
 *    this is the one that counts.
 *  - A save is all or nothing. If ANY value is rejected, nothing is written at
 *    all. Dropping the bad keys and saving the rest would silently discard the
 *    settings the user already had, which is a destructive save wearing the
 *    costume of a validation error.
 */
export function saveTheme(
  db: Db,
  params: {
    ownerType: "system" | "member";
    ownerId: string;
    accountId: string;
    now: number;
    tokens?: unknown;
    composition?: unknown;
  },
): SaveThemeResult {
  const level = params.ownerType === "member" ? "member" : "system";
  const rejected: Array<{ key: string; reason: ValidationFailure }> = [];

  let tokensJson: string | undefined;
  if (params.tokens !== undefined) {
    const clean = sanitizeTheme(params.tokens, { level });
    rejected.push(...clean.rejected);
    // Resets are stored as explicit nulls: absent means inherit, null means
    // reset to the platform default. Collapsing the two would lose the third
    // state entirely.
    const merged: Record<string, string | null> = { ...clean.values };
    for (const key of clean.resets) merged[key] = null;
    tokensJson = JSON.stringify(merged);
  }

  let compositionJson: string | undefined;
  if (params.composition !== undefined) {
    const clean = sanitizeComposition(params.composition, { level });
    rejected.push(...clean.rejected);
    const merged: Record<string, string | null> = { ...clean.values };
    for (const key of clean.resets) merged[key] = null;
    compositionJson = JSON.stringify(merged);
  }

  // Nothing is written unless everything validated.
  if (rejected.length > 0) return { ok: false, reason: "invalid", rejected };

  writeTx(db, (tx) => {
    const existing = tx
      .query<{ owner_id: string }, [string, string]>(
        "SELECT owner_id FROM themes WHERE owner_type = ? AND owner_id = ?",
      )
      .get(params.ownerType, params.ownerId);

    if (!existing) {
      tx.query(
        `INSERT INTO themes (owner_type, owner_id, schema_version, tokens, composition, updated_at, updated_by)
         VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).run(
        params.ownerType,
        params.ownerId,
        tokensJson ?? "{}",
        compositionJson ?? "{}",
        params.now,
        params.accountId,
      );
      return;
    }

    // Only the named layer is touched.
    if (tokensJson !== undefined) {
      tx.query(
        "UPDATE themes SET tokens = ?, updated_at = ?, updated_by = ?, deleted_at = NULL WHERE owner_type = ? AND owner_id = ?",
      ).run(tokensJson, params.now, params.accountId, params.ownerType, params.ownerId);
    }
    if (compositionJson !== undefined) {
      tx.query(
        "UPDATE themes SET composition = ?, updated_at = ?, updated_by = ?, deleted_at = NULL WHERE owner_type = ? AND owner_id = ?",
      ).run(compositionJson, params.now, params.accountId, params.ownerType, params.ownerId);
    }
  });

  return { ok: true };
}

// ------------------------------------------------------------------ members

export type ManagedMember = {
  memberId: string | null;
  pkMemberHid: string;
  pkMemberUuid: string;
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  pronouns: string | null;
  slug: string | null;
  hasThemeOverrides: boolean;
};

/**
 * Public members of a system, for the management list.
 *
 * Sourced from the same public PluralKit response the public site uses, so a
 * member PluralKit withholds is absent here too. The management UI must not
 * become a way to confirm that a private member exists (decision 5) — being
 * signed in as the owner does not change what the public API returns, and we do
 * not ask for more.
 */
export async function listManagedMembers(
  deps: ManageDeps,
  system: SystemRow,
): Promise<{ members: ManagedMember[]; reachable: boolean }> {
  let pkMembers: PkMember[];
  try {
    pkMembers = await deps.pk.getMembers(system.pk_system_uuid);
  } catch (err) {
    if (!(err instanceof PkError)) throw err;
    return { members: [], reachable: false };
  }

  const localRows = deps.db
    .query<{ id: string; pk_member_uuid: string }, [string]>(
      "SELECT id, pk_member_uuid FROM members WHERE system_id = ?",
    )
    .all(system.id);
  const localByUuid = new Map(localRows.map((r) => [r.pk_member_uuid, r.id]));

  const themed = new Set(
    deps.db
      .query<{ owner_id: string }, []>(
        "SELECT owner_id FROM themes WHERE owner_type = 'member' AND deleted_at IS NULL AND tokens != '{}'",
      )
      .all()
      .map((r) => r.owner_id),
  );

  const members = pkMembers.map((m) => {
    const memberId = localByUuid.get(m.uuid) ?? null;
    return {
      memberId,
      pkMemberHid: m.id,
      pkMemberUuid: m.uuid,
      name: m.name,
      displayName: m.display_name,
      avatarUrl: m.avatar_url,
      pronouns: m.pronouns,
      slug: memberId ? (activeSlugFor(deps.db, "member", memberId)?.slug_display ?? null) : null,
      hasThemeOverrides: memberId ? themed.has(memberId) : false,
    };
  });

  return { members, reachable: true };
}

/**
 * Finds or creates our local row for a member.
 *
 * Member rows are created lazily: one exists only once there is pkviewer data
 * to attach to it. Creating a row for every member of every system would store
 * a copy of PluralKit's roster for no reason.
 *
 * The member must be publicly visible to be given a row, so this cannot be used
 * to create records for members PluralKit withholds.
 */
export async function ensureMemberRow(
  deps: ManageDeps,
  system: SystemRow,
  memberRef: string,
): Promise<{ memberId: string; member: PkMember } | null> {
  let members: PkMember[];
  try {
    members = await deps.pk.getMembers(system.pk_system_uuid);
  } catch (err) {
    if (!(err instanceof PkError)) throw err;
    return null;
  }

  const ref = memberRef.toLowerCase();
  const member = members.find((m) => m.id.toLowerCase() === ref || m.uuid.toLowerCase() === ref);
  if (!member) return null;

  const existing = deps.db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE pk_member_uuid = ?")
    .get(member.uuid);
  if (existing) return { memberId: existing.id, member };

  const id = randomUUID();
  deps.db
    .query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    )
    .run(id, system.id, member.uuid, member.id, deps.now?.() ?? Date.now());
  return { memberId: id, member };
}

// ------------------------------------------------------------ social links

export type StoredSocialLink = {
  id: number;
  platform: string;
  label: string | null;
  url: string;
  visible: boolean;
  sortOrder: number;
};

export function listSocialLinks(
  db: Db,
  ownerType: "system" | "member",
  ownerId: string,
): StoredSocialLink[] {
  return db
    .query<
      {
        id: number;
        platform: string;
        label: string | null;
        url: string;
        visible: number;
        sort_order: number;
      },
      [string, string]
    >(
      `SELECT id, platform, label, url, visible, sort_order
         FROM social_links WHERE owner_type = ? AND owner_id = ?
        ORDER BY sort_order, id`,
    )
    .all(ownerType, ownerId)
    .map((r) => ({
      id: r.id,
      platform: r.platform,
      label: r.label,
      url: r.url,
      visible: r.visible === 1,
      sortOrder: r.sort_order,
    }));
}

export type SocialInput = {
  platform: string;
  label?: string | null;
  url: string;
  visible?: boolean;
};

export type SocialSaveFailure =
  | { field: "platform"; reason: "unknown_platform" }
  | { field: "url"; reason: SocialUrlFailure }
  | { field: "label"; reason: "too_long" }
  | { field: "links"; reason: "too_many" };

/**
 * Replaces an owner's social links with the given ordered list.
 *
 * Whole-list replacement keeps ordering trivially consistent — position in the
 * array is the order — and makes reordering, editing and deleting one operation
 * instead of three that can interleave badly.
 */
export function saveSocialLinks(
  db: Db,
  params: {
    ownerType: "system" | "member";
    ownerId: string;
    links: unknown;
  },
): { ok: true; saved: number } | { ok: false; errors: Array<SocialSaveFailure & { index: number }> } {
  if (!Array.isArray(params.links)) {
    return { ok: false, errors: [{ index: -1, field: "links", reason: "too_many" }] };
  }
  if (params.links.length > MAX_SOCIAL_LINKS) {
    return { ok: false, errors: [{ index: -1, field: "links", reason: "too_many" }] };
  }

  const errors: Array<SocialSaveFailure & { index: number }> = [];
  const clean: Array<{ platform: string; label: string | null; url: string; visible: number }> = [];

  params.links.forEach((raw, index) => {
    const item = raw as Partial<SocialInput> | null;
    const platform = typeof item?.platform === "string" ? item.platform : "";
    if (!SOCIAL_PLATFORM_IDS.includes(platform)) {
      errors.push({ index, field: "platform", reason: "unknown_platform" });
      return;
    }

    const url = validateSocialUrl(item?.url);
    if (!url.ok) {
      errors.push({ index, field: "url", reason: url.reason });
      return;
    }

    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (label.length > MAX_SOCIAL_LABEL_LENGTH) {
      errors.push({ index, field: "label", reason: "too_long" });
      return;
    }

    clean.push({
      platform,
      label: label.length > 0 ? label : null,
      url: url.url,
      visible: item?.visible === false ? 0 : 1,
    });
  });

  if (errors.length > 0) return { ok: false, errors };

  writeTx(db, (tx) => {
    tx.query("DELETE FROM social_links WHERE owner_type = ? AND owner_id = ?").run(
      params.ownerType,
      params.ownerId,
    );
    clean.forEach((link, index) => {
      tx.query(
        `INSERT INTO social_links (owner_type, owner_id, platform, label, url, visible, sort_order)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        params.ownerType,
        params.ownerId,
        link.platform,
        link.label,
        link.url,
        link.visible,
        index,
      );
    });
  });

  return { ok: true, saved: clean.length };
}
