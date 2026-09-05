import type { Context } from "hono";

/**
 * Cookie names carry the __Host- prefix, which is load-bearing rather than
 * decorative.
 *
 * __Host- forbids a Domain attribute, so the cookie is pinned to exactly one
 * host and cannot be sent to — or set from — a sibling subdomain. That is what
 * makes it safe to serve user-authored presentation from a sibling origin: the
 * session cookie provably cannot reach it, and a cookie set over there cannot
 * shadow this one.
 *
 * Browsers treat localhost as a trustworthy origin, so the required Secure
 * attribute does not break local development.
 */
export const SESSION_COOKIE = "__Host-pkv_session";
export const OAUTH_COOKIE = "__Host-pkv_oauth";

/** The OAuth handshake cookie is short-lived: it only spans the redirect. */
export const OAUTH_COOKIE_MAX_AGE_S = 10 * 60;

type CookieOptions = {
  maxAgeSeconds?: number;
  sameSite?: "Lax" | "Strict";
};

function serialize(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    `SameSite=${opts.sameSite ?? "Lax"}`,
  ];
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  // No Domain attribute, ever: __Host- forbids it, and it is the attribute that
  // would let this cookie leak across subdomains.
  return parts.join("; ");
}

export function setCookie(c: Context, name: string, value: string, opts?: CookieOptions): void {
  c.header("Set-Cookie", serialize(name, value, opts), { append: true });
}

export function clearCookie(c: Context, name: string): void {
  c.header("Set-Cookie", `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, {
    append: true,
  });
}

export function readCookie(c: Context, name: string): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
