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

  PUBLIC_APP_ORIGIN: originSchema,
  PUBLIC_USERCONTENT_ORIGIN: originSchema,
  PUBLIC_ASSET_ORIGIN: originSchema,

  API_PORT: z.coerce.number().int().positive().default(3001),
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

  appOrigin: string;
  userContentOrigin: string;
  assetOrigin: string;
  internalApiOrigin: string;
  apiPort: number;

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

  // The user-content origin is the boundary that keeps user-authored
  // presentation away from session cookies. Sharing an origin with the app
  // would silently void that, so this is fatal in every environment including
  // development — a dev setup that differs from production here would train us
  // to write code that is only safe by accident.
  if (e.PUBLIC_USERCONTENT_ORIGIN === e.PUBLIC_APP_ORIGIN) {
    throw new ConfigError(
      "PUBLIC_USERCONTENT_ORIGIN must not equal PUBLIC_APP_ORIGIN — " +
        "user-authored presentation requires its own origin.",
    );
  }

  if (isProduction) {
    for (const [key, value] of [
      ["PUBLIC_APP_ORIGIN", e.PUBLIC_APP_ORIGIN],
      ["PUBLIC_USERCONTENT_ORIGIN", e.PUBLIC_USERCONTENT_ORIGIN],
      ["PUBLIC_ASSET_ORIGIN", e.PUBLIC_ASSET_ORIGIN],
    ] as const) {
      if (!value.startsWith("https://")) {
        throw new ConfigError(`${key} must be https in production (got ${value})`);
      }
    }
    if (e.DISCORD_REDIRECT_URIS.length === 0) {
      throw new ConfigError("DISCORD_REDIRECT_URIS must list at least one URI in production");
    }
    if (e.SESSION_SECRET.length < 32) {
      throw new ConfigError(
        "SESSION_SECRET must be at least 32 characters in production. " +
          "Generate one with: openssl rand -base64 32",
      );
    }
    if (!e.DISCORD_CLIENT_ID || !e.DISCORD_CLIENT_SECRET) {
      throw new ConfigError(
        "DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required in production; " +
          "without them nobody can sign in.",
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

    appOrigin: e.PUBLIC_APP_ORIGIN,
    userContentOrigin: e.PUBLIC_USERCONTENT_ORIGIN,
    assetOrigin: e.PUBLIC_ASSET_ORIGIN,
    internalApiOrigin: e.INTERNAL_API_ORIGIN,
    apiPort: e.API_PORT,

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
