import { resolveComposition, type MemberView, type PageModel, type SocialLink, type SystemView } from "@pkviewer/shared";
import type { Db } from "../db/index.ts";
import type { PkClient } from "../pk/client.ts";
import type { PkMember, PkSystem } from "../pk/types.ts";
import { activeSlugFor } from "../slugs/claim.ts";
import { memberPath, resolveMemberRef, resolveSystemRef, systemPath } from "../slugs/resolve.ts";

/**
 * Builds the fully resolved model a public page renders from.
 *
 * The rendering tier makes ONE call per page and receives everything already
 * merged — PluralKit data, slugs, socials, theme tokens. Server-side rendering
 * is then a single hop rather than a fan-out, and the web tier never needs to
 * know how any of it is assembled.
 *
 * Only data PluralKit already returns publicly appears here. Members PluralKit
 * withholds are simply absent, which is what makes a private member
 * indistinguishable from one that never existed (decision 5).
 */

export type PageFailure = "not_found" | "unsupported_reference" | "upstream_unavailable";
export type PageResult<T> = { ok: true; value: T } | { ok: false; reason: PageFailure };

type Deps = { db: Db; pk: PkClient; now?: () => number; freshnessMs?: number };

function socialsFor(db: Db, ownerType: "system" | "member", ownerId: string | null): SocialLink[] {
  if (!ownerId) return [];
  return db
    .query<{ platform: string; label: string | null; url: string }, [string, string]>(
      `SELECT platform, label, url FROM social_links
        WHERE owner_type = ? AND owner_id = ? AND visible = 1
        ORDER BY sort_order, id`,
    )
    .all(ownerType, ownerId)
    .map((r) => ({ platform: r.platform, label: r.label, url: r.url }));
}

/**
 * Stored theme tokens for an owner.
 *
 * Returned as an opaque flat map. The renderer turns whatever keys exist into
 * CSS custom properties without knowing their names, so the token VOCABULARY
 * can be defined by the design pass without touching this code.
 */
function layerFor(
  db: Db,
  ownerType: "system" | "member",
  ownerId: string | null,
  column: "tokens" | "composition",
): Record<string, string | null> {
  if (!ownerId) return {};
  const row = db
    .query<{ value: string }, [string, string]>(
      `SELECT ${column} AS value FROM themes
        WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
    )
    .get(ownerType, ownerId);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // null is meaningful: it is the explicit "reset to the platform default"
      // state. Filtering it out here silently collapsed three inheritance
      // states into two, so a member reset landed on the system value instead.
      if (typeof v === "string" || v === null) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function tokensFor(db: Db, ownerType: "system" | "member", ownerId: string | null) {
  return layerFor(db, ownerType, ownerId, "tokens");
}

function compositionFor(db: Db, ownerType: "system" | "member", ownerId: string | null) {
  return layerFor(db, ownerType, ownerId, "composition");
}

/**
 * Merges system tokens under member tokens.
 *
 * Absent key means inherit; an explicit null means reset to the platform
 * default, which is represented here by omitting the key entirely so the
 * renderer falls back. The three-state model lives in this one function.
 */
export function resolveTokens(
  systemTokens: Record<string, string | null>,
  memberTokens: Record<string, string | null> | null,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(systemTokens)) {
    if (typeof value === "string") merged[key] = value;
  }
  if (!memberTokens) return merged;
  for (const [key, value] of Object.entries(memberTokens)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function toSystemView(
  system: PkSystem,
  opts: {
    slug: string | null;
    memberCount: number;
    claimed: boolean;
    staleSinceMs: number | null;
    showPronouns: boolean;
    bannerVisible: boolean;
  },
): SystemView {
  return {
    hid: system.id,
    slug: opts.slug,
    name: system.name,
    description: system.description,
    tag: system.tag,
    pronouns: opts.showPronouns ? system.pronouns : null,
    avatarUrl: system.avatar_url,
    bannerUrl: opts.bannerVisible ? system.banner : null,
    color: system.color,
    memberCount: opts.memberCount,
    claimed: opts.claimed,
    staleSinceMs: opts.staleSinceMs,
  };
}

/**
 * Fields hidden by composition are removed here, not merely hidden in markup.
 *
 * A visibility setting that only styles a value away still ships it in the page
 * source, which is not what "hide pronouns" reasonably means. This is public
 * PluralKit data either way, so nothing private is at stake — but a privacy
 * setting should do what it says.
 */
function toMemberView(
  member: PkMember,
  ctx: {
    systemHid: string;
    systemSlug: string | null;
    slug: string | null;
    showPronouns: boolean;
    showBirthday: boolean;
  },
): MemberView {
  return {
    hid: member.id,
    slug: ctx.slug,
    systemHid: ctx.systemHid,
    systemSlug: ctx.systemSlug,
    name: member.name,
    displayName: member.display_name,
    description: member.description,
    pronouns: ctx.showPronouns ? member.pronouns : null,
    avatarUrl: member.avatar_url,
    bannerUrl: member.banner,
    color: member.color,
    birthday: ctx.showBirthday ? member.birthday : null,
  };
}

/** Slugs for a batch of members, so the directory can link canonically. */
function memberSlugMap(db: Db, systemId: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!systemId) return out;
  const rows = db
    .query<{ pk_member_uuid: string; slug_display: string }, [string]>(
      `SELECT m.pk_member_uuid AS pk_member_uuid, s.slug_display AS slug_display
         FROM slugs s
         JOIN members m ON m.id = s.subject_id
        WHERE s.scope = 'member' AND s.scope_key = ? AND s.state = 'active'`,
    )
    .all(systemId);
  for (const r of rows) out.set(r.pk_member_uuid, r.slug_display);
  return out;
}

export async function buildSystemPage(
  deps: Deps,
  ref: string,
): Promise<PageResult<PageModel & { canonicalPath: string }>> {
  const resolved = await resolveSystemRef(deps, ref);
  if (!resolved.ok) return resolved;

  const { system, systemId, slug, cacheRef } = resolved.value;

  let members: PkMember[] = [];
  try {
    members = await deps.pk.getMembers(system.uuid);
  } catch {
    // A system whose member list is private still has a page; it simply has no
    // directory. This is indistinguishable from a system with no members, by
    // design.
    members = [];
  }

  const slugs = memberSlugMap(deps.db, systemId);
  const composition = resolveComposition(compositionFor(deps.db, "system", systemId), {});
  const showPronouns = composition["show.pronouns"] !== "false";
  const showBirthday = composition["show.birthday"] !== "false";
  const bannerVisible = composition["banner.display"] !== "hidden";

  return {
    ok: true,
    value: {
      system: toSystemView(system, {
        slug,
        memberCount: members.length,
        claimed: systemId !== null,
        staleSinceMs: stalenessFor(deps, "system", cacheRef),
        showPronouns,
        bannerVisible,
      }),
      member: null,
      members: members.map((m) =>
        toMemberView(m, {
          systemHid: system.id,
          systemSlug: slug,
          slug: slugs.get(m.uuid) ?? null,
          showPronouns,
          showBirthday,
        }),
      ),
      socials: socialsFor(deps.db, "system", systemId),
      tokens: resolveTokens(tokensFor(deps.db, "system", systemId), null),
      composition,
      beta: false, // set by the route from config
      canonicalPath: systemPath(system.id, slug),
    },
  };
}

export async function buildMemberPage(
  deps: Deps,
  ref: string,
  memberRef: string,
): Promise<PageResult<PageModel & { canonicalPath: string }>> {
  const resolvedSystem = await resolveSystemRef(deps, ref);
  if (!resolvedSystem.ok) return resolvedSystem;

  const resolvedMember = await resolveMemberRef(deps, resolvedSystem.value, memberRef);
  if (!resolvedMember.ok) return resolvedMember;

  const { system, systemId, slug: systemSlug, cacheRef } = resolvedSystem.value;
  const { member, memberId, slug: memberSlug } = resolvedMember.value;

  // Member tokens override the system's; an explicit null resets to platform
  // default rather than inheriting.
  const systemTokens = tokensFor(deps.db, "system", systemId);
  const memberTokens = tokensFor(deps.db, "member", memberId);
  const composition = resolveComposition(
    compositionFor(deps.db, "system", systemId),
    compositionFor(deps.db, "member", memberId),
  );
  const showPronouns = composition["show.pronouns"] !== "false";
  const showBirthday = composition["show.birthday"] !== "false";
  const bannerVisible = composition["banner.display"] !== "hidden";

  return {
    ok: true,
    value: {
      system: toSystemView(system, {
        slug: systemSlug,
        memberCount: 0,
        claimed: systemId !== null,
        staleSinceMs: stalenessFor(deps, "system", cacheRef),
        showPronouns,
        bannerVisible,
      }),
      member: toMemberView(member, {
        systemHid: system.id,
        systemSlug,
        slug: memberSlug,
        showPronouns,
        showBirthday,
      }),
      members: [],
      socials: socialsFor(deps.db, "member", memberId),
      tokens: resolveTokens(systemTokens, memberTokens),
      composition,
      beta: false,
      canonicalPath: memberPath(system.id, systemSlug, member.id, memberSlug),
    },
  };
}

/**
 * How stale the data behind this page is, in milliseconds, or null when fresh.
 *
 * PluralKit downtime must not take public pages down (P3): the client falls
 * back to the last good snapshot, and this is what lets the page say so rather
 * than presenting old data as current.
 */
function stalenessFor(deps: Deps, refType: "system", refKey: string): number | null {
  const age = deps.pk.snapshotAge(refType, refKey);
  if (age === null) return null;
  const threshold = deps.freshnessMs ?? 60_000;
  return age > threshold ? age : null;
}
