/**
 * Web-tier configuration.
 *
 * Only origins and flags: the rendering tier holds no secrets and no database
 * credentials. Every value is read from the environment so the deployment
 * origin stays configuration rather than architecture (decision 1).
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value.replace(/\/+$/, "");
}

export const webConfig = {
  /**
   * The one user-facing origin: /, /login, /auth, /manage and /s all live here.
   *
   * Used only where an absolute URL is genuinely required — canonical links,
   * OpenGraph, and addresses shown for copying. Navigation within pkviewer uses
   * relative paths, which is now always same-origin.
   */
  publicOrigin: required("PUBLIC_ORIGIN", "http://system.localhost:3000"),
  /** Internal only. Never reaches the browser. */
  apiOrigin: required("INTERNAL_API_ORIGIN", "http://127.0.0.1:3001"),
  /**
   * Where the documentation lives.
   *
   * Hardcoded, unlike pkviewer's own origin. The domain-portability rule exists
   * so pkviewer can move hosts without a rebuild; this is not pkviewer's host,
   * it is a fixed destination pkviewer links to — the same category as a
   * repository URL. Making it configuration only meant it could be forgotten,
   * which is exactly what happened: the option existed, nothing documented it,
   * and no docs link ever appeared.
   *
   * It is also the route to support: the docs site's own footer carries the
   * Discord, Matrix and repository links.
   */
  docsUrl: "https://docs.doughmination.gay",
} as const;

export function hostOf(origin: string): string {
  return new URL(origin).host;
}
