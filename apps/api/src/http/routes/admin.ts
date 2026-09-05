import { Hono } from "hono";
import type { Context } from "hono";
import { BADGE_ICON_IDS, BADGE_TONE_IDS, BADGE_STATES, type BadgeState } from "@pkviewer/shared";
import {
  badgeNeedsNoConsent,
  buildCreditsPage,
  deleteCredit,
  deleteSection,
  grantBadge,
  isAdmin,
  listAssignments,
  listBadges,
  listCredits,
  listRecognitionAudit,
  listSections,
  restoreBadge,
  retireBadge,
  revokeBadge,
  saveBadge,
  saveCredit,
  saveSection,
} from "../../admin/index.ts";
import { resolveSession } from "../../auth/sessions.ts";
import { accountManagesSystem, ensureSystemRow } from "../../claims/index.ts";
import type { Config } from "../../config/index.ts";
import type { Db } from "../../db/index.ts";
import type { PkClient } from "../../pk/client.ts";
import { PkError } from "../../pk/errors.ts";
import { readCookie, SESSION_COOKIE } from "../cookies.ts";

type Deps = { cfg: Config; db: Db; pk: PkClient; now?: () => number };

/**
 * The administration API.
 *
 * Every route here requires the platform admin grant, and that is ALL it
 * requires — there is deliberately no route that reads or writes another
 * account's system, theme, slug or links. Administering pkviewer and managing
 * a system are different powers, held through different grants, served by
 * different modules.
 *
 * A non-admin gets 404 rather than 403, matching the management plane: 403
 * would confirm that an admin API exists at this path.
 */
export function adminRoutes(deps: Deps): Hono {
  const { db, pk } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();

  const admin = (c: Context): string | Response => {
    const token = readCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    const accountId = resolveSession(db, token, now())?.accountId ?? null;
    if (!accountId) return c.json({ error: "unauthenticated" }, 401);
    if (!isAdmin(db, accountId)) return c.json({ error: "not_found" }, 404);
    return accountId;
  };

  /** Whether the caller is an admin. Used by the web tier to show the nav link. */
  app.get("/whoami", (c) => {
    const token = readCookie(c, SESSION_COOKIE);
    const accountId = token ? resolveSession(db, token, now())?.accountId ?? null : null;
    return c.json({ admin: accountId !== null && isAdmin(db, accountId) });
  });

  // ------------------------------------------------------------- catalogue --

  app.get("/badges", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    return c.json({
      badges: listBadges(db, { includeRetired: true }),
      icons: BADGE_ICON_IDS,
      tones: BADGE_TONE_IDS,
    });
  });

  app.put("/badges/:badgeId", async (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = saveBadge(
      db,
      {
        id: c.req.param("badgeId"),
        label: body["label"] as string,
        description: body["description"] as string,
        icon: body["icon"] as string,
        tone: body["tone"] as string,
        sortOrder: Number(body["sortOrder"] ?? 0),
      },
      now(),
    );
    if (!result.ok) return c.json({ error: "invalid", failures: result.failures }, 422);
    return c.json({ badge: result.badge });
  });

  app.post("/badges/:badgeId/retire", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const ok = retireBadge(db, c.req.param("badgeId"), now(), who);
    return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  app.post("/badges/:badgeId/restore", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const ok = restoreBadge(db, c.req.param("badgeId"), now(), who);
    return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  // ------------------------------------------------------------ assignment --

  app.get("/assignments", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const state = c.req.query("state");
    const filter =
      state && (BADGE_STATES as readonly string[]).includes(state)
        ? (state as BadgeState)
        : undefined;
    return c.json({ assignments: listAssignments(db, filter) });
  });

  /**
   * Grants a badge.
   *
   * The subject is named by pkviewer address or PluralKit HID rather than by
   * internal id: an admin is looking at a page, not at a database.
   *
   * A system pkviewer has never seen is resolved through PluralKit and given a
   * local row — but ONLY for a badge that needs no consent. Granting a
   * consent-required badge to a stranger would create an offer nobody can ever
   * receive: it would read as granted in the admin list and be invisible
   * everywhere else, permanently. Refusing says so instead.
   */
  app.post("/assignments", async (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ref = typeof body["subject"] === "string" ? body["subject"].trim() : "";
    const badgeId = String(body["badgeId"] ?? "");
    if (!ref) return c.json({ error: "invalid", failures: [{ field: "subject", reason: "required" }] }, 422);

    let systemId = resolveSystemId(db, ref);

    if (!systemId) {
      if (!badgeNeedsNoConsent(db, badgeId)) {
        return c.json({ error: "unknown_subject" }, 404);
      }
      // A read against the public PluralKit API, exactly as a public page does.
      // No credential, and nothing is written unless PluralKit knows the system.
      try {
        const pkSystem = await pk.getSystem(normalizeRef(ref));
        systemId = ensureSystemRow(db, pkSystem, now());
      } catch (err) {
        if (err instanceof PkError && err.status === 404) {
          return c.json({ error: "unknown_subject" }, 404);
        }
        return c.json({ error: "upstream_unavailable" }, 502);
      }
    }

    // Consent is the reason a grant starts pending. When the granting admin is
    // also the system's manager there is nobody else to ask.
    const autoAccept = accountManagesSystem(db, who, systemId);

    const result = grantBadge(
      db,
      {
        subjectId: systemId,
        badgeId,
        note: body["note"],
        byAccount: who,
        autoAccept,
      },
      now(),
    );
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "unknown_subject" ? 404 : 422);
    return c.json({ assignment: result.assignment });
  });

  app.post("/assignments/:id/revoke", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "not_found" }, 404);
    return revokeBadge(db, id, now(), who) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  // --------------------------------------------------------------- credits --

  app.get("/credits", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    return c.json({
      sections: listSections(db),
      credits: listCredits(db, { includeHidden: true }),
      preview: buildCreditsPage(db),
    });
  });

  app.put("/credits/sections/:sectionId", async (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = saveSection(
      db,
      {
        id: c.req.param("sectionId"),
        label: body["label"],
        description: body["description"],
        sortOrder: Number(body["sortOrder"] ?? 0),
      },
      now(),
      who,
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: "invalid", failures: result.failures }, 422);
  });

  app.delete("/credits/sections/:sectionId", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const result = deleteSection(db, c.req.param("sectionId"), now(), who);
    if (result.ok) return c.json({ ok: true });
    return c.json({ error: result.reason }, result.reason === "not_empty" ? 409 : 404);
  });

  app.post("/credits", async (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = saveCredit(
      db,
      {
        sectionId: String(body["sectionId"] ?? ""),
        name: body["name"],
        detail: body["detail"],
        url: body["url"],
        sortOrder: Number(body["sortOrder"] ?? 0),
        visible: body["visible"] !== false,
      },
      now(),
      who,
    );
    return result.ok ? c.json({ id: result.id }) : c.json({ error: "invalid", failures: result.failures }, 422);
  });

  app.put("/credits/:creditId", async (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = saveCredit(
      db,
      {
        id: c.req.param("creditId"),
        sectionId: String(body["sectionId"] ?? ""),
        name: body["name"],
        detail: body["detail"],
        url: body["url"],
        sortOrder: Number(body["sortOrder"] ?? 0),
        visible: body["visible"] !== false,
      },
      now(),
      who,
    );
    return result.ok ? c.json({ id: result.id }) : c.json({ error: "invalid", failures: result.failures }, 422);
  });

  app.delete("/credits/:creditId", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    return deleteCredit(db, c.req.param("creditId"), now(), who)
      ? c.json({ ok: true })
      : c.json({ error: "not_found" }, 404);
  });

  // ----------------------------------------------------------------- audit --

  app.get("/audit", (c) => {
    const who = admin(c);
    if (who instanceof Response) return who;
    return c.json({ events: listRecognitionAudit(db, 100) });
  });

  return app;
}

/**
 * Finds a local system by pkviewer address or PluralKit HID.
 *
 * Read-only by design. A system with no local row has never been claimed, so
 * there is nobody who could accept a badge offered to it.
 */
function normalizeRef(ref: string): string {
  return ref.replace(/^\/+s\/+/, "").toLowerCase();
}

function resolveSystemId(db: Db, ref: string): string | null {
  const normalized = normalizeRef(ref);

  const bySlug = db
    .query<{ subject_id: string | null }, [string]>(
      `SELECT subject_id FROM slugs
        WHERE scope = 'system' AND state = 'active' AND slug_normalized = ?`,
    )
    .get(normalized);
  if (bySlug?.subject_id) return bySlug.subject_id;

  const byHid = db
    .query<{ id: string }, [string]>("SELECT id FROM systems WHERE pk_system_hid = ?")
    .get(normalized);
  if (byHid) return byHid.id;

  const byId = db.query<{ id: string }, [string]>("SELECT id FROM systems WHERE id = ?").get(ref);
  return byId?.id ?? null;
}
