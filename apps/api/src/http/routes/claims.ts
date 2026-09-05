import { Hono } from "hono";
import type { Context } from "hono";
import { discordIdsForAccount, resolveSession } from "../../auth/sessions.ts";
import {
  claimViaDiscordLink,
  claimViaToken,
  createDescriptionChallenge,
  discoverLinkedSystems,
  systemsForAccount,
  unclaimSystem,
  verifyDescriptionChallenge,
} from "../../claims/index.ts";
import type { Config } from "../../config/index.ts";
import type { Db } from "../../db/index.ts";
import type { PkClient } from "../../pk/client.ts";
import { readCookie, SESSION_COOKIE } from "../cookies.ts";
import { canClaim } from "./auth.ts";

type Deps = { cfg: Config; db: Db; pk: PkClient; now?: () => number };

type Caller = { accountId: string; discordIds: string[] };

function caller(c: Context, db: Db, now: number): Caller | null {
  const token = readCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = resolveSession(db, token, now);
  if (!session) return null;
  return { accountId: session.accountId, discordIds: discordIdsForAccount(db, session.accountId) };
}

/**
 * Claim-flow endpoints.
 *
 * Every route requires a session. Claiming is additionally gated during beta by
 * an allow-list of Discord ids — public viewing never is.
 */
export function claimRoutes(deps: Deps): Hono {
  const { cfg, db, pk } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();
  const claimDeps = { db, pk, now };

  const requireClaimant = (c: Context): Caller | Response => {
    const who = caller(c, db, now());
    if (!who) return c.json({ error: "unauthenticated" }, 401);
    if (!canClaim(cfg, who.discordIds)) {
      return c.json(
        { error: "beta_not_allowed", detail: "claiming is limited during the beta" },
        403,
      );
    }
    return who;
  };

  /** Systems this account manages. */
  app.get("/mine", (c) => {
    const who = caller(c, db, now());
    if (!who) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ systems: systemsForAccount(db, who.accountId) });
  });

  /**
   * Tier 1 discovery: systems linked to this account's verified Discord ids.
   *
   * The ids come from the session, never from the request body, so a caller
   * cannot probe arbitrary Discord accounts through us.
   */
  app.post("/discover", async (c) => {
    const who = requireClaimant(c);
    if (who instanceof Response) return who;

    const systems = await discoverLinkedSystems(claimDeps, who.discordIds);
    return c.json({
      systems: systems.map((s) => ({ hid: s.id, uuid: s.uuid, name: s.name })),
    });
  });

  app.post("/discord-link", async (c) => {
    const who = requireClaimant(c);
    if (who instanceof Response) return who;

    const body = await c.req.json().catch(() => null);
    const ref = typeof body?.systemRef === "string" ? body.systemRef : null;
    if (!ref) return c.json({ error: "bad_request" }, 400);

    const result = await claimViaDiscordLink(claimDeps, {
      accountId: who.accountId,
      discordIds: who.discordIds,
      pkSystemRef: ref,
    });
    return claimResponse(c, result);
  });

  app.post("/challenge", async (c) => {
    const who = requireClaimant(c);
    if (who instanceof Response) return who;

    const body = await c.req.json().catch(() => null);
    const ref = typeof body?.systemRef === "string" ? body.systemRef : null;
    if (!ref) return c.json({ error: "bad_request" }, 400);

    const result = await createDescriptionChallenge(claimDeps, {
      accountId: who.accountId,
      pkSystemRef: ref,
    });
    if (!result.ok) return c.json({ error: result.reason }, statusFor(result.reason));

    return c.json({
      challengeId: result.challenge.id,
      nonce: result.challenge.nonce,
      systemHid: result.challenge.pkSystemHid,
      expiresAt: result.challenge.expiresAt,
    });
  });

  app.post("/challenge/verify", async (c) => {
    const who = requireClaimant(c);
    if (who instanceof Response) return who;

    const body = await c.req.json().catch(() => null);
    const id = typeof body?.challengeId === "string" ? body.challengeId : null;
    if (!id) return c.json({ error: "bad_request" }, 400);

    const result = await verifyDescriptionChallenge(claimDeps, {
      accountId: who.accountId,
      challengeId: id,
    });
    return claimResponse(c, result);
  });

  /**
   * Tier 3. The token arrives in a POST body, never a URL, and is discarded
   * inside the handler. Nothing here logs the request body.
   */
  app.post("/token", async (c) => {
    const who = requireClaimant(c);
    if (who instanceof Response) return who;

    const body = await c.req.json().catch(() => null);
    const ref = typeof body?.systemRef === "string" ? body.systemRef : null;
    const token = typeof body?.token === "string" ? body.token : null;
    if (!ref || !token) return c.json({ error: "bad_request" }, 400);

    const result = await claimViaToken(claimDeps, {
      accountId: who.accountId,
      pkSystemRef: ref,
      token,
    });
    return claimResponse(c, result);
  });

  app.post("/unclaim", async (c) => {
    const who = caller(c, db, now());
    if (!who) return c.json({ error: "unauthenticated" }, 401);

    const body = await c.req.json().catch(() => null);
    const systemId = typeof body?.systemId === "string" ? body.systemId : null;
    const confirm = body?.confirm === true;
    if (!systemId) return c.json({ error: "bad_request" }, 400);
    // Unclaiming is destructive from the user's point of view; the client must
    // say so explicitly rather than a stray request doing it.
    if (!confirm) return c.json({ error: "confirmation_required" }, 400);

    const result = unclaimSystem(claimDeps, { accountId: who.accountId, systemId });
    if (!result.ok) {
      return c.json({ error: result.reason }, result.reason === "not_owner" ? 403 : 404);
    }
    return c.json({ ok: true, slugsReleased: result.slugsReleased });
  });

  return app;
}

function statusFor(reason: string): 400 | 403 | 404 | 409 | 502 {
  switch (reason) {
    case "not_found":
    case "challenge_not_found":
      return 404;
    case "already_claimed":
      return 409;
    case "beta_not_allowed":
      return 403;
    case "upstream_unavailable":
      return 502;
    default:
      return 400;
  }
}

function claimResponse(
  c: Context,
  result: { ok: true; systemId: string; pkSystemHid: string; method: string; restored: boolean } | { ok: false; reason: string },
) {
  if (result.ok) {
    return c.json({
      ok: true,
      systemId: result.systemId,
      systemHid: result.pkSystemHid,
      method: result.method,
      restored: result.restored,
    });
  }
  // "already_claimed" deliberately carries no information about who holds it.
  return c.json({ error: result.reason }, statusFor(result.reason));
}
