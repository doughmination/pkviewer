import type { Db } from "../db/index.ts";
import type { PkClient } from "../pk/client.ts";
import { PkNotFound } from "../pk/errors.ts";
import type { PkMember, PkSystem } from "../pk/types.ts";
import { activeSlugFor } from "./claim.ts";
import { effectiveState, findSlug } from "./lifecycle.ts";
import { looksLikeSnowflake, normalizeSlug } from "./normalize.ts";

/**
 * Resolving `/s/<ref>` and `/s/<ref>/<memberRef>`.
 *
 * Both the PluralKit id and the pkviewer slug resolve (decision 8), and the
 * slug is canonical. Neither is a redirect: a 301 would outlive slug ownership
 * and permanently point a cached URL at whoever holds the name next, so both
 * forms return 200 and the canonical one is advertised via <link rel=canonical>.
 *
 * Resolution order is slug first, then id. That is safe because a system slug
 * can never take the shape of a system id (see normalize.ts), so the two
 * namespaces do not overlap at the system level.
 */

export type ResolvedSystem = {
  system: PkSystem;
  /** Our row, when the system has been claimed here. */
  systemId: string | null;
  slug: string | null;
  matchedBy: "slug" | "id";
  /** The URL this page should advertise as canonical. */
  canonicalPath: string;
  /**
   * The reference the PluralKit response was actually cached under.
   *
   * A slug resolves via the stored UUID while an id resolves via the id itself,
   * so callers asking "how old is this data" must use the same key the fetch
   * used. Guessing the UUID silently misses for id-based URLs, which is how the
   * stale-data notice came to appear on address URLs but not id URLs.
   */
  cacheRef: string;
};

export type ResolveFailure = "not_found" | "unsupported_reference" | "upstream_unavailable";

export type ResolveResult<T> = { ok: true; value: T } | { ok: false; reason: ResolveFailure };

/** Path for a system, preferring its slug. */
export function systemPath(hid: string, slug: string | null): string {
  return `/s/${slug ?? hid}`;
}

/** Path for a member, preferring slugs at both levels. */
export function memberPath(
  systemHid: string,
  systemSlug: string | null,
  memberHid: string,
  memberSlug: string | null,
): string {
  return `${systemPath(systemHid, systemSlug)}/${memberSlug ?? memberHid}`;
}

/**
 * Resolves a public system reference.
 *
 * A Discord snowflake is refused. PluralKit resolves a linked account id to its
 * system, which is what tier-1 claiming depends on, but accepting it here would
 * turn the Discord-account to system mapping into something anyone could browse
 * by walking ids. Claiming uses that lookup with ids taken from the session;
 * public URLs do not expose it.
 */
export async function resolveSystemRef(
  deps: { db: Db; pk: PkClient; now?: () => number },
  ref: string,
): Promise<ResolveResult<ResolvedSystem>> {
  const now = deps.now?.() ?? Date.now();

  if (looksLikeSnowflake(ref)) return { ok: false, reason: "unsupported_reference" };

  const normalized = normalizeSlug(ref);
  const slugRow = findSlug(deps.db, "system", "", normalized);

  if (slugRow) {
    const state = effectiveState(slugRow, now);
    if (state.kind === "active") {
      const row = deps.db
        .query<{ pk_system_uuid: string; pk_system_hid: string }, [string]>(
          "SELECT pk_system_uuid, pk_system_hid FROM systems WHERE id = ?",
        )
        .get(state.subjectId);
      if (row) {
        try {
          const system = await deps.pk.getSystem(row.pk_system_uuid);
          return {
            ok: true,
            value: {
              system,
              systemId: state.subjectId,
              slug: slugRow.slug_display,
              matchedBy: "slug",
              canonicalPath: systemPath(system.id, slugRow.slug_display),
              cacheRef: row.pk_system_uuid,
            },
          };
        } catch (err) {
          return { ok: false, reason: failureFor(err) };
        }
      }
    }
    // A reserved or lapsed slug is not a live page. Falling through lets the
    // same string still resolve as a PluralKit id if it happens to be one.
  }

  try {
    const system = await deps.pk.getSystem(ref);
    const local = deps.db
      .query<{ id: string }, [string]>("SELECT id FROM systems WHERE pk_system_uuid = ?")
      .get(system.uuid);
    const slug = local ? (activeSlugFor(deps.db, "system", local.id)?.slug_display ?? null) : null;

    return {
      ok: true,
      value: {
        system,
        systemId: local?.id ?? null,
        slug,
        matchedBy: "id",
        canonicalPath: systemPath(system.id, slug),
        cacheRef: ref,
      },
    };
  } catch (err) {
    return { ok: false, reason: failureFor(err) };
  }
}

export type ResolvedMember = {
  member: PkMember;
  memberId: string | null;
  slug: string | null;
  matchedBy: "slug" | "id";
  canonicalPath: string;
};

/**
 * Resolves a member within an already-resolved system.
 *
 * Member slugs MAY take the shape of a member id, because their namespace is
 * scoped to one system. Slug wins when both match, so a deliberate slug always
 * beats an incidental id collision inside the same system — and claiming such a
 * slug warns the owner that it shadows a sibling's id URL.
 *
 * Members that PluralKit does not return publicly are simply absent here, which
 * is what makes a private member indistinguishable from one that never existed
 * (decision 5).
 */
export async function resolveMemberRef(
  deps: { db: Db; pk: PkClient; now?: () => number },
  system: ResolvedSystem,
  memberRef: string,
): Promise<ResolveResult<ResolvedMember>> {
  const now = deps.now?.() ?? Date.now();
  const normalized = normalizeSlug(memberRef);

  let members: PkMember[];
  try {
    members = await deps.pk.getMembers(system.system.uuid);
  } catch (err) {
    return { ok: false, reason: failureFor(err) };
  }

  if (system.systemId) {
    const slugRow = findSlug(deps.db, "member", system.systemId, normalized);
    if (slugRow) {
      const state = effectiveState(slugRow, now);
      if (state.kind === "active") {
        const row = deps.db
          .query<{ pk_member_uuid: string }, [string]>(
            "SELECT pk_member_uuid FROM members WHERE id = ?",
          )
          .get(state.subjectId);
        const member = row ? members.find((m) => m.uuid === row.pk_member_uuid) : undefined;
        // A slug pointing at a member PluralKit no longer returns publicly
        // resolves to nothing, rather than revealing that the member exists.
        if (member) {
          return {
            ok: true,
            value: {
              member,
              memberId: state.subjectId,
              slug: slugRow.slug_display,
              matchedBy: "slug",
              canonicalPath: memberPath(
                system.system.id,
                system.slug,
                member.id,
                slugRow.slug_display,
              ),
            },
          };
        }
      }
    }
  }

  const byId = members.find(
    (m) => m.id.toLowerCase() === normalized || m.uuid.toLowerCase() === normalized,
  );
  if (!byId) return { ok: false, reason: "not_found" };

  const local = deps.db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE pk_member_uuid = ?")
    .get(byId.uuid);
  const slug = local ? (activeSlugFor(deps.db, "member", local.id)?.slug_display ?? null) : null;

  return {
    ok: true,
    value: {
      member: byId,
      memberId: local?.id ?? null,
      slug,
      matchedBy: "id",
      canonicalPath: memberPath(system.system.id, system.slug, byId.id, slug),
    },
  };
}

function failureFor(err: unknown): ResolveFailure {
  return err instanceof PkNotFound ? "not_found" : "upstream_unavailable";
}
