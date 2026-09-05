import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PKVIEWER_VERSION } from "./version.ts";

/**
 * All deployment-varying values enter the application here and nowhere else.
 *
 * The domain the beta happens to run on is configuration, not architecture: no
 * absolute pkviewer URL is persisted to the database, and every public URL is
 * composed at render time from these origins. Moving from the beta host to the
 * eventual production domain is then an env change, not a migration.
 */

const originSchema = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an absolute URL: ${raw}` });
      return z.NEVER;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `origin must be http(s): ${raw}` });
      return z.NEVER;
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `origin must have no path: ${raw}` });
      return z.NEVER;
    }
    // Normalised: no trailing slash, so callers can concatenate paths freely.
    return url.origin;
  });

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean));

const boolish = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** The single user-facing origin. Serves /, /login, /auth, /manage and /s. */
  PUBLIC_ORIGIN: originSchema,
  /**
   * Optional; defaults to PUBLIC_ORIGIN. Reserved for serving media elsewhere.
   *
   * An empty value counts as absent: a .env file that lists the key with nothing
   * after it is expressing "not set", not "set to the empty string".
   */
  PUBLIC_ASSET_ORIGIN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    originSchema.optional(),
  ),

  API_PORT: z.coerce.number().int().positive().default(3001),
  /**
   * Interface the API binds to. Loopback by default.
   *
   * The API is internal: the browser never calls it, the web tier proxies
   * everything. Binding every interface would put the management API directly
   * on the network, which is exactly what the architecture says must not
   * happen. Containers set 0.0.0.0 because the network namespace provides the
   * isolation instead — and must not publish the port.
   */
  API_HOST: z.string().min(1).default("127.0.0.1"),
  INTERNAL_API_ORIGIN: originSchema,

  DATABASE_PATH: z.string().min(1).default("./data/pkviewer.db"),

  PK_API_BASE: z.string().url().default("https://api.pluralkit.me/v2"),
  PK_USER_AGENT_CONTACT: z.string().url(),
  PK_RATE_LIMIT_READ_RPS: z.coerce.number().positive().default(6),
  PK_RATE_LIMIT_WRITE_RPS: z.coerce.number().positive().default(2),

  DISCORD_CLIENT_ID: z.string().default(""),
  DISCORD_CLIENT_SECRET: z.string().default(""),
  DISCORD_REDIRECT_URIS: csv,

  BETA_MODE: boolish,
  SIGNUP_ENABLED: boolish,
  BETA_ALLOWED_DISCORD_IDS: csv,

  SESSION_SECRET: z.string().default(""),
});

export type Config = Readonly<{
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;

  /**
   * The one user-facing origin.
   *
   * pkviewer previously split public pages from the management UI across two
   * hosts so the session cookie could not reach user-authored presentation.
   * That split is gone by product decision; see docs/decisions.md O1.
   */
  publicOrigin: string;
  assetOrigin: string;
  internalApiOrigin: string;
  apiPort: number;
  apiHost: string;

  databasePath: string;

  pk: {
    apiBase: string;
    /** The single canonical User-Agent. Never varies by user, server or shard. */
    userAgent: string;
    readRps: number;
    writeRps: number;
  };

  discord: {
    clientId: string;
    clientSecret: string;
    redirectUris: readonly string[];
  };

  beta: {
    enabled: boolean;
    signupEnabled: boolean;
    allowedDiscordIds: ReadonlySet<string>;
  };

  sessionSecret: string;
}>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Parses and validates configuration. Throws rather than returning a partial
 * config: a process that boots with an invalid security-relevant origin is
 * worse than one that refuses to boot.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // pkviewer used to run on two user-facing origins. A configuration still
  // carrying the old names would otherwise fail with a confusing "PUBLIC_ORIGIN
  // is required", so name the change instead.
  if (!env["PUBLIC_ORIGIN"] && (env["PUBLIC_APP_ORIGIN"] || env["PUBLIC_USERCONTENT_ORIGIN"])) {
    throw new ConfigError(
      "PUBLIC_APP_ORIGIN and PUBLIC_USERCONTENT_ORIGIN have been replaced by a " +
        "single PUBLIC_ORIGIN. pkviewer now serves public pages and the " +
        "management UI from one origin. Set PUBLIC_ORIGIN and remove the other two.",
    );
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`invalid configuration:\n${detail}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";

  /**
   * Outside production, an absent session secret becomes a random one rather
   * than an empty string.
   *
   * An empty HMAC key would still "work", which is the problem: the OAuth
   * handshake cookie would be trivially forgeable locally and nothing would say
   * so. A per-start random value keeps development honest and costs nothing —
   * sessions are opaque database tokens, not signed with this, so a restart
   * only invalidates in-flight logins.
   */
  let sessionSecret = e.SESSION_SECRET;
  if (!isProduction && sessionSecret.length === 0) {
    sessionSecret = randomBytes(32).toString("base64url");
    console.warn(
      "[config] SESSION_SECRET is not set; generated an ephemeral one for this run. " +
        "Set it in .env to keep logins working across restarts.",
    );
  }

  if (isProduction) {
    for (const [key, value] of [
      ["PUBLIC_ORIGIN", e.PUBLIC_ORIGIN],
      ["PUBLIC_ASSET_ORIGIN", e.PUBLIC_ASSET_ORIGIN ?? e.PUBLIC_ORIGIN],
    ] as const) {
      if (!value.startsWith("https://")) {
        // Session cookies are Secure and __Host- prefixed, so sign-in cannot
        // work over http. TLS terminates at the proxy in front; this is the
        // public URL people visit, not the address the container listens on.
        throw new ConfigError(
          `${key} must be https in production (got ${value}). ` +
            "It is the public URL visitors use — TLS terminates at your reverse " +
            "proxy, and the container itself still speaks http behind it.",
        );
      }
    }

    if (e.SESSION_SECRET.length < 32) {
      throw new ConfigError(
        "SESSION_SECRET must be at least 32 characters in production. " +
          "Generate one with: openssl rand -base64 32",
      );
    }
    /**
     * Incomplete Discord configuration warns; it does not stop the server.
     *
     * Every public page works without it — only sign-in is unavailable, and
     * that endpoint already answers 503. Refusing to boot made a read-only
     * deployment impossible and blocked bringing a stack up before the OAuth
     * application exists, which is the normal order of doing things.
     */
    const discordReady =
      e.DISCORD_CLIENT_ID && e.DISCORD_CLIENT_SECRET && e.DISCORD_REDIRECT_URIS.length > 0;
    if (!discordReady) {
      console.warn(
        "[config] Discord sign-in is not configured, so nobody can sign in. " +
          "Public pages work normally. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET " +
          "and DISCORD_REDIRECT_URIS to enable it.",
      );
    }
  }

  for (const uri of e.DISCORD_REDIRECT_URIS) {
    try {
      new URL(uri);
    } catch {
      throw new ConfigError(`DISCORD_REDIRECT_URIS contains a non-URL entry: ${uri}`);
    }
  }

  // Claiming on a beta deployment is gated by an explicit allow-list. Public
  // viewing is never gated — that is the point of the platform.
  if (e.BETA_MODE && e.SIGNUP_ENABLED && e.BETA_ALLOWED_DISCORD_IDS.length === 0 && isProduction) {
    throw new ConfigError(
      "BETA_MODE with SIGNUP_ENABLED requires BETA_ALLOWED_DISCORD_IDS to be non-empty",
    );
  }

  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    isProduction,

    publicOrigin: e.PUBLIC_ORIGIN,
    assetOrigin: e.PUBLIC_ASSET_ORIGIN ?? e.PUBLIC_ORIGIN,
    internalApiOrigin: e.INTERNAL_API_ORIGIN,
    apiPort: e.API_PORT,
    apiHost: e.API_HOST,

    databasePath: e.DATABASE_PATH,

    pk: Object.freeze({
      apiBase: e.PK_API_BASE.replace(/\/+$/, ""),
      userAgent: buildUserAgent(e.PK_USER_AGENT_CONTACT),
      readRps: e.PK_RATE_LIMIT_READ_RPS,
      writeRps: e.PK_RATE_LIMIT_WRITE_RPS,
    }),

    discord: Object.freeze({
      clientId: e.DISCORD_CLIENT_ID,
      clientSecret: e.DISCORD_CLIENT_SECRET,
      redirectUris: Object.freeze(e.DISCORD_REDIRECT_URIS),
    }),

    beta: Object.freeze({
      enabled: e.BETA_MODE,
      signupEnabled: e.SIGNUP_ENABLED,
      allowedDiscordIds: new Set(e.BETA_ALLOWED_DISCORD_IDS),
    }),

    sessionSecret,
  });
}

/**
 * The canonical User-Agent, e.g. `pkviewer/0.1.0 (+https://github.com/o/pkviewer)`.
 *
 * The contact URL points at the repository rather than the deployment origin on
 * purpose: PluralKit asks that an application's UA be stable and identifiable,
 * and the repository URL survives the beta -> production domain move that the
 * deployment origin would not.
 */
export function buildUserAgent(contactUrl: string): string {
  return `pkviewer/${PKVIEWER_VERSION} (+${contactUrl})`;
}

let cached: Config | undefined;
/** Process-wide config, parsed once. */
export function config(): Config {
  return (cached ??= loadConfig());
}
