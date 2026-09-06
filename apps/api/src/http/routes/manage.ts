import { Hono } from "hono";
import type { Context } from "hono";
import { resolveSession } from "../../auth/sessions.ts";
import type { Config } from "../../config/index.ts";
import type { Db } from "../../db/index.ts";
import {
  authorizeSystem,
  ensureMemberRow,
  listManagedMembers,
  listManagedSystems,
  listSocialLinks,
  readTheme,
  saveSocialLinks,
  saveTheme,
  readCss,
  saveCss,
  type SystemRow,
} from "../../manage/index.ts";
import { offeredBadgesFor, respondToBadge, type RespondAction } from "../../manage/recognition.ts";
import type { PkClient } from "../../pk/client.ts";
import { PkError } from "../../pk/errors.ts";
import { activeSlugFor } from "../../slugs/claim.ts";
import { readCookie, SESSION_COOKIE } from "../cookies.ts";

type Deps = { cfg: Config; db: Db; pk: PkClient; now?: () => number };

/**
 * The management API.
 *
 * Every route requires a session, and every system-scoped route re-checks the
 * grant. Authorization is never inferred from a path the client chose: the
 * client can ask about any system id it likes and will be told 404 for every
 * one it does not manage.
 */
export function manageRoutes(deps: Deps): Hono {
  const { db, pk } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();
  const manageDeps = { db, pk, now };

  const account = (c: Context): string | null => {
    const token = readCookie(c, SESSION_COOKIE);
    if (!token) return null;
    return resolveSession(db, token, now())?.accountId ?? null;
  };

  /**
   * Resolves the system for a request, or the response to send instead.
   *
   * A system the caller cannot manage is reported as 404, not 403: 403 would
   * confirm the system exists on pkviewer, which is not something an
   * unauthorised caller should be able to probe for.
   */
  const withSystem = (
    c: Context,
  ): { accountId: string; system: SystemRow } | Response => {
    const accountId = account(c);
    if (!accountId) return c.json({ error: "unauthenticated" }, 401);
    const system = authorizeSystem(db, accountId, c.req.param("systemId") ?? "");
    if (!system) return c.json({ error: "not_found" }, 404);
    return { accountId, system };
  };

  app.get("/systems", async (c) => {
    const accountId = account(c);
    if (!accountId) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ systems: await listManagedSystems(manageDeps, accountId) });
  });

  app.get("/systems/:systemId", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    const { system } = ctx;

    const slug = activeSlugFor(db, "system", system.id)?.slug_display ?? null;
    let name: string | null = null;
    let avatarUrl: string | null = null;
    let description: string | null = null;
    let memberCount: number | null = null;
    let reachable = true;

    try {
      const pkSystem = await pk.getSystem(system.pk_system_uuid);
      name = pkSystem.name;
      avatarUrl = pkSystem.avatar_url;
      description = pkSystem.description;
      memberCount = (await pk.getMembers(system.pk_system_uuid)).length;
    } catch (err) {
      if (!(err instanceof PkError)) throw err;
      reachable = false;
    }

    return c.json({
      systemId: system.id,
      pkSystemHid: system.pk_system_hid,
      name,
      avatarUrl,
      description,
      memberCount,
      slug,
      publicPath: `/s/${slug ?? system.pk_system_hid}`,
      snapshotAgeMs: pk.snapshotAge("system", system.pk_system_uuid),
      reachable,
    });
  });

  // ------------------------------------------------------------------ theme

  app.get("/systems/:systemId/theme", (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    const stored = readTheme(db, "system", ctx.system.id);
    return c.json({ tokens: stored.tokens, composition: stored.composition });
  });

  app.put("/systems/:systemId/theme", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;

    const body = (await c.req.json().catch(() => null)) as {
      tokens?: unknown;
      composition?: unknown;
    } | null;
    if (!body) return c.json({ error: "bad_request" }, 400);

    // Only the layers actually present are written, so saving appearance can
    // never wipe directory settings, and vice versa.
    const result = saveTheme(db, {
      ownerType: "system",
      ownerId: ctx.system.id,
      accountId: ctx.accountId,
      now: now(),
      ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
      ...(body.composition !== undefined ? { composition: body.composition } : {}),
    });

    // Rejected means nothing was written: the caller's existing settings stand.
    if (!result.ok) {
      return c.json({ ok: false, error: "validation_failed", rejected: result.rejected }, 422);
    }

    audit(db, now(), ctx.accountId, "theme.system.saved", ctx.system.id);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- members

  app.get("/systems/:systemId/members", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    const result = await listManagedMembers(manageDeps, ctx.system);
    return c.json(result);
  });

  app.get("/systems/:systemId/members/:memberRef", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;

    const found = await ensureMemberRow(manageDeps, ctx.system, c.req.param("memberRef") ?? "");
    // A member PluralKit does not return publicly is a 404 here too. Being the
    // owner does not make a private member visible through pkviewer.
    if (!found) return c.json({ error: "not_found" }, 404);

    const stored = readTheme(db, "member", found.memberId);
    return c.json({
      memberId: found.memberId,
      pkMemberHid: found.member.id,
      name: found.member.name,
      displayName: found.member.display_name,
      avatarUrl: found.member.avatar_url,
      pronouns: found.member.pronouns,
      slug: activeSlugFor(db, "member", found.memberId)?.slug_display ?? null,
      tokens: stored.tokens,
      socials: listSocialLinks(db, "member", found.memberId),
      systemTokens: readTheme(db, "system", ctx.system.id).tokens,
    });
  });

  app.put("/systems/:systemId/members/:memberRef/theme", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;

    const found = await ensureMemberRow(manageDeps, ctx.system, c.req.param("memberRef") ?? "");
    if (!found) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => null)) as { tokens?: unknown } | null;
    if (!body) return c.json({ error: "bad_request" }, 400);

    const result = saveTheme(db, {
      ownerType: "member",
      ownerId: found.memberId,
      accountId: ctx.accountId,
      now: now(),
      ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
    });

    if (!result.ok) {
      return c.json({ ok: false, error: "validation_failed", rejected: result.rejected }, 422);
    }

    audit(db, now(), ctx.accountId, "theme.member.saved", found.memberId);
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------------- social

  app.get("/systems/:systemId/socials", (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    return c.json({ links: listSocialLinks(db, "system", ctx.system.id) });
  });

  app.put("/systems/:systemId/socials", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;

    const body = (await c.req.json().catch(() => null)) as { links?: unknown } | null;
    if (!body) return c.json({ error: "bad_request" }, 400);

    const result = saveSocialLinks(db, {
      ownerType: "system",
      ownerId: ctx.system.id,
      links: body.links,
    });
    if (!result.ok) return c.json({ error: "validation_failed", errors: result.errors }, 422);

    audit(db, now(), ctx.accountId, "socials.system.saved", ctx.system.id);
    return c.json({ ok: true, saved: result.saved });
  });

  app.put("/systems/:systemId/members/:memberRef/socials", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;

    const found = await ensureMemberRow(manageDeps, ctx.system, c.req.param("memberRef") ?? "");
    if (!found) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => null)) as { links?: unknown } | null;
    if (!body) return c.json({ error: "bad_request" }, 400);

    const result = saveSocialLinks(db, {
      ownerType: "member",
      ownerId: found.memberId,
      links: body.links,
    });
    if (!result.ok) return c.json({ error: "validation_failed", errors: result.errors }, 422);

    audit(db, now(), ctx.accountId, "socials.member.saved", found.memberId);
    return c.json({ ok: true, saved: result.saved });
  });

  /**
   * Custom CSS.
   *
   * The API compiles on save and stores the result; the web tier renders what
   * it is given. Both halves of that matter — the compiler is the security
   * boundary, so it must be the only one, and it must not run at render time.
   */
  app.get("/systems/:systemId/css", (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    return c.json(readCss(db, "system", ctx.system.id));
  });

  app.put("/systems/:systemId/css", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = saveCss(
      db,
      { ownerType: "system", ownerId: ctx.system.id, source: body["css"], accountId: ctx.accountId },
      now(),
    );
    if (!result.ok) return c.json({ error: "invalid", issues: result.issues }, 422);
    audit(db, now(), ctx.accountId, "css.saved", ctx.system.id);
    return c.json({ ok: true, issues: result.issues, kept: result.kept });
  });

  /**
   * A member's own stylesheet.
   *
   * Layered over the system's on a member page rather than replacing it, in the
   * same order and for the same reason as the token vocabulary: a member starts
   * from the system's look and overrides what they want different, instead of
   * starting from nothing.
   */
  app.get("/systems/:systemId/members/:memberRef/css", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    const found = await ensureMemberRow(manageDeps, ctx.system, c.req.param("memberRef") ?? "");
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(readCss(db, "member", found.memberId));
  });

  app.put("/systems/:systemId/members/:memberRef/css", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    const found = await ensureMemberRow(manageDeps, ctx.system, c.req.param("memberRef") ?? "");
    if (!found) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = saveCss(
      db,
      { ownerType: "member", ownerId: found.memberId, source: body["css"], accountId: ctx.accountId },
      now(),
    );
    if (!result.ok) return c.json({ error: "invalid", issues: result.issues }, 422);
    audit(db, now(), ctx.accountId, "css.member.saved", found.memberId);
    return c.json({ ok: true, issues: result.issues, kept: result.kept });
  });

  /**
   * Recognition offered to this system.
   *
   * The recipient's half of a badge. Granting is an admin power; deciding
   * whether it shows on your own page is not, so it lives here behind the
   * ordinary system grant rather than behind the admin plane.
   */
  app.get("/systems/:systemId/badges", (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    return c.json({ badges: offeredBadgesFor(db, ctx.system.id) });
  });

  app.post("/systems/:systemId/badges/:badgeId", async (c) => {
    const ctx = withSystem(c);
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body["action"];
    if (action !== "accept" && action !== "decline" && action !== "hide" && action !== "show") {
      return c.json({ error: "invalid_action" }, 422);
    }
    const result = respondToBadge(
      db,
      ctx.system.id,
      c.req.param("badgeId"),
      action as RespondAction,
      now(),
      ctx.accountId,
    );
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409);
    return c.json({ ok: true, state: result.state });
  });

  return app;
}

function audit(db: Db, at: number, accountId: string, action: string, target: string): void {
  db.query(
    "INSERT INTO audit_events (at, account_id, action, target, detail) VALUES (?,?,?,?,?)",
  ).run(at, accountId, action, target, null);
}
