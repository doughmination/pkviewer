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
  /** Session-bearing. /login, /auth, /manage. */
  appOrigin: required("PUBLIC_APP_ORIGIN", "http://app.localhost:3000"),
  /** Public and shareable. / and /s/... Never receives the session cookie. */
  publicOrigin: required("PUBLIC_USERCONTENT_ORIGIN", "http://system.localhost:3000"),
  /** Internal only. Never reaches the browser. */
  apiOrigin: required("INTERNAL_API_ORIGIN", "http://127.0.0.1:3001"),
  /**
   * Where the documentation lives.
   *
   * Documentation is a separate site, not part of this application. It is a
   * deployment hostname like any other, so it is configuration rather than a
   * literal in the code.
   */
  docsUrl: (process.env["PUBLIC_DOCS_URL"] ?? "").replace(/\/+$/, ""),
  beta: (process.env["BETA_MODE"] ?? "true") === "true",
} as const;

export function hostOf(origin: string): string {
  return new URL(origin).host;
}
