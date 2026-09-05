import { Hono } from "hono";
import type { Context } from "hono";
import { discordIdsForAccount, resolveSession } from "../../auth/sessions.ts";
import { accountManagesSystem } from "../../claims/index.ts";
import type { Config } from "../../config/index.ts";
import type { Db } from "../../db/index.ts";
import type { PkClient } from "../../pk/client.ts";
import { PkError } from "../../pk/errors.ts";
import { activeSlugFor, checkSlugAvailability, claimSlug } from "../../slugs/claim.ts";
import { RESERVATION_MS, findSlug, releaseSlug, reservationsForSubject } from "../../slugs/lifecycle.ts";
import { SLUG_REJECTION_MESSAGES, type SlugScope } from "../../slugs/normalize.ts";
import { readCookie, SESSION_COOKIE } from "../cookies.ts";

type Deps = { cfg: Config; db: Db; pk: PkClient; now?: () => number };

function accountFor(c: Context, db: Db, now: number): string | null {
  const token = readCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return resolveSession(db, token, now)?.accountId ?? null;
}

/**
 * Slug management. Lives under /manage on the app origin (decision 3), never
 * under /s/, so a member slug can never collide with an application route.
 */
export function slugRoutes(deps: Deps): Hono {
  const { db, pk } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();

  /**
   * Resolves the caller's authority over a subject.
   *
   * Member slugs are authorised through the member's SYSTEM: members are not
   * independent principals in MVP (decision 9), and the grants table already
   * models them for when they become one.
   */
  const authorize = (
    c: Context,
    accountId: string,
    scope: SlugScope,
    subjectId: string,
  ): { scopeKey: string; systemId: string } | Response => {
    if (scope === "system") {
      if (!accountManagesSystem(db, accountId, subjectId)) {
        return c.json({ error: "forbidden" }, 403);
      }
      return { scopeKey: "", systemId: subjectId };
    }
    const member = db
      .query<{ system_id: string }, [string]>("SELECT system_id FROM members WHERE id = ?")
      .get(subjectId);
    if (!member) return c.json({ error: "not_found" }, 404);
    if (!accountManagesSystem(db, accountId, member.system_id)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return { scopeKey: member.system_id, systemId: member.system_id };
  };

  app.get("/check", (c) => {
    const accountId = accountFor(c, db, now());
    if (!accountId) return c.json({ error: "unauthenticated" }, 401);

    const scope = c.req.query("scope") === "member" ? "member" : "system";
    const requested = c.req.query("slug") ?? "";
    const subjectId = c.req.query("subjectId") ?? undefined;

    let scopeKey = "";
    if (scope === "member") {
      const systemId = c.req.query("systemId");
      if (!systemId) return c.json({ error: "bad_request" }, 400);
      if (!accountManagesSystem(db, accountId, systemId)) {
        return c.json({ error: "forbidden" }, 403);
      }
      scopeKey = systemId;
    }

    const result = checkSlugAvailability(db, {
      scope,
      scopeKey,
      ...(subjectId ? { subjectId } : {}),
      requested,
      now: now(),
    });

    return c.json({
      ...result,
      message:
        !result.available && result.reason === "invalid"
          ? SLUG_REJECTION_MESSAGES[result.detail]
          : undefined,
    });
  });

  /**
   * Everything the address editor needs for one subject: the address in use,
   * and any addresses still held for it after a change.
   */
  app.get("/status", (c) => {
    const accountId = accountFor(c, db, now());
    if (!accountId) return c.json({ error: "unauthenticated" }, 401);

    const scope: SlugScope = c.req.query("scope") === "member" ? "member" : "system";
    const subjectId = c.req.query("subjectId");
    if (!subjectId) return c.json({ error: "bad_request" }, 400);

    const auth = authorize(c, accountId, scope, subjectId);
    if (auth instanceof Response) return auth;

    const t = now();
    const current = activeSlugFor(db, scope, subjectId);
    return c.json({
      current: current
        ? { slug: current.slug_display, claimedAt: current.claimed_at ?? null }
        : null,
      reservations: reservationsForSubject(db, scope, subjectId, t),
      reservationDays: Math.round(RESERVATION_MS / 86_400_000),
    });
  });

  app.post("/claim", async (c) => {
    const accountId = accountFor(c, db, now());
    if (!accountId) return c.json({ error: "unauthenticated" }, 401);

    const body = await c.req.json().catch(() => null);
    const scope: SlugScope = body?.scope === "member" ? "member" : "system";
    const subjectId = typeof body?.subjectId === "string" ? body.subjectId : null;
    const requested = typeof body?.slug === "string" ? body.slug : null;
    if (!subjectId || !requested) return c.json({ error: "bad_request" }, 400);

    const auth = authorize(c, accountId, scope, subjectId);
    if (auth instanceof Response) return auth;

    // Sibling ids let us warn when a member slug shadows another member's id
    // URL inside the same system. Advisory only, and a PluralKit hiccup must
    // not block a slug change, so failure here is swallowed.
    let siblingHids: string[] = [];
    if (scope === "member") {
      const system = db
        .query<{ pk_system_uuid: string }, [string]>(
          "SELECT pk_system_uuid FROM systems WHERE id = ?",
        )
        .get(auth.systemId);
      const self = db
        .query<{ pk_member_uuid: string }, [string]>(
          "SELECT pk_member_uuid FROM members WHERE id = ?",
        )
        .get(subjectId);
      if (system) {
        try {
          const members = await pk.getMembers(system.pk_system_uuid);
          siblingHids = members
            .filter((m) => m.uuid !== self?.pk_member_uuid)
            .map((m) => m.id);
        } catch (err) {
          if (!(err instanceof PkError)) throw err;
        }
      }
    }

    const result = claimSlug(db, {
      scope,
      scopeKey: auth.scopeKey,
      subjectId,
      requested,
      accountId,
      now: now(),
      siblingHids,
    });

    if (!result.ok) {
      switch (result.kind) {
        case "invalid":
          return c.json(
            { error: "invalid", detail: result.reason, message: SLUG_REJECTION_MESSAGES[result.reason] },
            400,
          );
        case "taken":
          return c.json({ error: "taken" }, 409);
        case "reserved":
          // Never reveals who holds the reservation, only when it lapses.
          return c.json({ error: "reserved", availableAt: result.until }, 409);
        case "conflict":
          return c.json({ error: "conflict" }, 409);
      }
    }

    db.query(
      "INSERT INTO audit_events (at, account_id, action, target, detail) VALUES (?,?,?,?,?)",
    ).run(now(), accountId, `slug.${result.kind}`, subjectId, result.slug);

    return c.json({
      ok: true,
      kind: result.kind,
      slug: result.slug,
      previousSlug: result.previousSlug,
      warnings: result.warnings,
    });
  });

  app.post("/release", async (c) => {
    const accountId = accountFor(c, db, now());
    if (!accountId) return c.json({ error: "unauthenticated" }, 401);

    const body = await c.req.json().catch(() => null);
    const scope: SlugScope = body?.scope === "member" ? "member" : "system";
    const subjectId = typeof body?.subjectId === "string" ? body.subjectId : null;
    if (!subjectId) return c.json({ error: "bad_request" }, 400);
    if (body?.confirm !== true) return c.json({ error: "confirmation_required" }, 400);

    const auth = authorize(c, accountId, scope, subjectId);
    if (auth instanceof Response) return auth;

    const current = activeSlugFor(db, scope, subjectId);
    if (!current) return c.json({ error: "no_slug" }, 404);

    const t = now();
    if (!releaseSlug(db, current, t, accountId)) return c.json({ error: "conflict" }, 409);

    db.query(
      "INSERT INTO audit_events (at, account_id, action, target, detail) VALUES (?,?,?,?,?)",
    ).run(t, accountId, "slug.released", subjectId, current.slug_display);

    const row = findSlug(db, scope, auth.scopeKey, current.slug_normalized);
    return c.json({
      ok: true,
      released: current.slug_display,
      // The previous holder can reclaim until this moment; afterwards anyone can.
      reservedUntil: row?.reserved_until ?? null,
    });
  });

  app.get("/mine", (c) => {
    const accountId = accountFor(c, db, now());
    if (!accountId) return c.json({ error: "unauthenticated" }, 401);
    void discordIdsForAccount(db, accountId);

    const rows = db
      .query<
        { subject_id: string; slug_display: string; scope: string },
        [string]
      >(
        `SELECT sl.subject_id AS subject_id, sl.slug_display AS slug_display, sl.scope AS scope
           FROM slugs sl
           JOIN grants g
             ON g.subject_type = 'system'
            AND (g.subject_id = sl.subject_id OR g.subject_id = sl.scope_key)
          WHERE g.account_id = ? AND sl.state = 'active'`,
      )
      .all(accountId);

    return c.json({ slugs: rows });
  });

  return app;
}
