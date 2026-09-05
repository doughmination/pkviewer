import type { MiddlewareHandler } from "hono";
import type { Config } from "../config/index.ts";

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Frame-Options", "DENY");
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence: every state-changing request must carry an Origin we recognise.
 *
 * This matters more now that pkviewer serves public pages and the management UI
 * from one origin: SameSite=Lax and this check are what stand between a
 * cross-site form post and a management write.
 *
 * An Origin check is the primary defence rather than a synchronised token
 * because it has no plumbing and no failure mode where a stale token locks a
 * user out. Requests with no Origin header at all are rejected on mutating
 * methods; browsers always send one for cross-origin state changes.
 */
export function requireKnownOrigin(cfg: Config): MiddlewareHandler {
  const allowed = new Set([cfg.publicOrigin, cfg.internalApiOrigin]);
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    const origin = c.req.header("origin");
    if (!origin || !allowed.has(origin)) {
      return c.json(
        { error: "forbidden", detail: "missing or unrecognised Origin on a state-changing request" },
        403,
      );
    }
    return next();
  };
}
