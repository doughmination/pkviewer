import { Hono } from "hono";
import { buildCreditsPage, listBadges } from "../../admin/index.ts";
import type { Config } from "../../config/index.ts";
import type { Db } from "../../db/index.ts";
import type { PkClient } from "../../pk/client.ts";
import { buildMemberPage, buildSystemPage, type PageFailure } from "../../public/page-model.ts";

type Deps = { cfg: Config; db: Db; pk: PkClient; now?: () => number };

/**
 * Public page models. No session is read here and none is required: public
 * browsing never depends on an account.
 */
export function publicRoutes(deps: Deps): Hono {
  const { db, pk } = deps;
  const app = new Hono();
  const pageDeps = { db, pk, ...(deps.now ? { now: deps.now } : {}) };

  app.get("/systems/:ref", async (c) => {
    const result = await buildSystemPage(pageDeps, c.req.param("ref"));
    if (!result.ok) return c.json({ error: result.reason }, statusFor(result.reason));
    return c.json(result.value);
  });

  app.get("/systems/:ref/members/:memberRef", async (c) => {
    const result = await buildMemberPage(
      pageDeps,
      c.req.param("ref"),
      c.req.param("memberRef"),
    );
    if (!result.ok) return c.json({ error: result.reason }, statusFor(result.reason));
    return c.json(result.value);
  });

  /**
   * The credits page and the badge glossary.
   *
   * Both are platform-owned content with no subject and no session, so they sit
   * beside the other public reads rather than behind the management plane.
   */
  app.get("/credits", (c) => c.json({ sections: buildCreditsPage(db) }));
  app.get("/badges", (c) => c.json({ badges: listBadges(db) }));

  return app;
}

function statusFor(reason: PageFailure): 404 | 502 {
  // "unsupported_reference" is reported as 404 rather than 400: a Discord
  // snowflake is simply not a public pkviewer identifier, and distinguishing it
  // would confirm the shape is meaningful somewhere (S7).
  return reason === "upstream_unavailable" ? 502 : 404;
}
