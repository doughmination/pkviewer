import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildUserAgent, ConfigError, loadConfig } from "../src/config/index.ts";
import { PKVIEWER_VERSION } from "../src/config/version.ts";

const base = {
  NODE_ENV: "development",
  PUBLIC_ORIGIN: "http://localhost:3000",
  INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
  PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
};

describe("config", () => {
  test("parses a valid development environment", () => {
    const cfg = loadConfig(base);
    expect(cfg.publicOrigin).toBe("http://localhost:3000");
    expect(cfg.beta.enabled).toBe(false);
    expect(cfg.pk.readRps).toBe(6);
  });

  test("normalises origins by stripping trailing slashes", () => {
    const cfg = loadConfig({ ...base, PUBLIC_ORIGIN: "http://localhost:3000/" });
    expect(cfg.publicOrigin).toBe("http://localhost:3000");
  });

  test("rejects an origin carrying a path", () => {
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: "http://localhost:3000/app" })).toThrow(
      ConfigError,
    );
  });

  // pkviewer used to run on two user-facing origins. A configuration still
  // carrying the old names would otherwise fail with a confusing "PUBLIC_ORIGIN
  // is required", so the error names the change instead.
  test("a configuration using the old two-origin names says what to do", () => {
    const { PUBLIC_ORIGIN: _replaced, ...withoutNew } = base;
    for (const stale of ["PUBLIC_APP_ORIGIN", "PUBLIC_USERCONTENT_ORIGIN"]) {
      expect(() => loadConfig({ ...withoutNew, [stale]: "http://localhost:3000" })).toThrow(
        /PUBLIC_ORIGIN/,
      );
    }
  });

  test("the old names are ignored once PUBLIC_ORIGIN is set", () => {
    const cfg = loadConfig({
      ...base,
      PUBLIC_APP_ORIGIN: "http://stale.example",
      PUBLIC_USERCONTENT_ORIGIN: "http://also-stale.example",
    });
    expect(cfg.publicOrigin).toBe("http://localhost:3000");
  });

  test("the asset origin falls back to the public origin", () => {
    expect(loadConfig(base).assetOrigin).toBe("http://localhost:3000");
    expect(loadConfig({ ...base, PUBLIC_ASSET_ORIGIN: "https://media.example" }).assetOrigin).toBe(
      "https://media.example",
    );
  });

  test("requires https origins in production", () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        DISCORD_REDIRECT_URIS: "https://example.test/cb",
        SESSION_SECRET: "x".repeat(32),
      }),
    ).toThrow(/must be https in production/);
  });

  test("requires a session secret in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://system.example",
        INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
        PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
        DISCORD_REDIRECT_URIS: "https://system.example/auth/discord/callback",
        DISCORD_CLIENT_ID: "id",
        DISCORD_CLIENT_SECRET: "secret",
        SESSION_SECRET: "short",
      }),
    ).toThrow(/SESSION_SECRET/);
  });

  test("accepts several Discord redirect URIs so a domain move needs no flag day", () => {
    const cfg = loadConfig({
      ...base,
      DISCORD_REDIRECT_URIS:
        "https://beta.example/auth/discord/callback, https://prod.example/auth/discord/callback",
    });
    expect(cfg.discord.redirectUris).toHaveLength(2);
  });

  test("rejects a non-URL redirect URI", () => {
    expect(() => loadConfig({ ...base, DISCORD_REDIRECT_URIS: "not-a-url" })).toThrow(ConfigError);
  });
});

describe("user agent", () => {
  test("identifies pkviewer and carries a contact URL", () => {
    expect(buildUserAgent("https://github.com/owner/pkviewer")).toBe(
      `pkviewer/${PKVIEWER_VERSION} (+https://github.com/owner/pkviewer)`,
    );
  });

  // The UA must be identical across instances and over time. Deriving it from
  // the deployment origin would change it on the beta -> production move, which
  // is the thing PluralKit uses it to avoid.
  test("does not depend on the deployment origin", () => {
    const a = loadConfig({ ...base, PUBLIC_ORIGIN: "https://beta.example" });
    const b = loadConfig({ ...base, PUBLIC_ORIGIN: "https://production.example" });
    expect(a.pk.userAgent).toBe(b.pk.userAgent);
  });
});

describe("beta readiness", () => {
  // An empty HMAC key would still "work", which is exactly the problem.
  test("an absent session secret becomes a random one outside production", () => {
    const a = loadConfig(base);
    const b = loadConfig(base);
    expect(a.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(a.sessionSecret).not.toBe(b.sessionSecret);
  });

  test("a provided session secret is used as-is", () => {
    const cfg = loadConfig({ ...base, SESSION_SECRET: "y".repeat(40) });
    expect(cfg.sessionSecret).toBe("y".repeat(40));
  });

  const prodBase = {
    NODE_ENV: "production",
    PUBLIC_ORIGIN: "https://app.example",
    INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
    PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
    DISCORD_REDIRECT_URIS: "https://app.example/auth/discord/callback",
    DISCORD_CLIENT_ID: "id",
    DISCORD_CLIENT_SECRET: "secret",
    SESSION_SECRET: "z".repeat(40),
  };

  test("a complete production environment loads", () => {
    expect(() => loadConfig(prodBase)).not.toThrow();
  });

  // Production must never fall back to a generated secret: that would make
  // every restart silently invalidate in-flight logins, and hide a missing var.
  test("production refuses a missing session secret rather than generating one", () => {
    const { SESSION_SECRET: _omitted, ...withoutSecret } = prodBase;
    expect(() => loadConfig(withoutSecret)).toThrow(/SESSION_SECRET/);
  });

  // Every public page works without Discord; only sign-in is unavailable, and
  // that endpoint answers 503. Refusing to boot made a read-only deployment
  // impossible and blocked bringing a stack up before the OAuth app exists.
  test("production starts without Discord credentials, for a read-only deployment", () => {
    const { DISCORD_CLIENT_SECRET: _s, DISCORD_CLIENT_ID: _i, DISCORD_REDIRECT_URIS: _r, ...readOnly } =
      prodBase;
    const cfg = loadConfig(readOnly);
    expect(cfg.discord.clientId).toBe("");
    expect(cfg.discord.redirectUris).toEqual([]);
  });

  test("an http origin in production explains where TLS belongs", () => {
    expect(() => loadConfig({ ...prodBase, PUBLIC_ORIGIN: "http://system.example" })).toThrow(
      /reverse\s+proxy/,
    );
  });

  test("the error names the missing variable so it can be fixed", () => {
    try {
      loadConfig({ ...base, PK_USER_AGENT_CONTACT: "" });
      throw new Error("expected a failure");
    } catch (err) {
      expect(String(err)).toContain("PK_USER_AGENT_CONTACT");
    }
  });
});

// .env.example is the first thing a fresh checkout copies into place, so a
// placeholder left in it becomes a live value on somebody's machine. This one
// matters more than most: PK_USER_AGENT_CONTACT is the contact URL PluralKit
// is given for every request we make (P1), and shipping an unresolvable one
// hands them a dead link instead of a way to reach us.
describe("the example environment file", () => {
  const exampleEnv = readFileSync(join(import.meta.dir, "..", "..", "..", ".env.example"), "utf8");

  const exampleValue = (key: string): string => {
    const match = exampleEnv.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (!match?.[1]) throw new Error(`${key} is missing or empty in .env.example`);
    return match[1].trim();
  };

  test("ships a PluralKit contact URL that config accepts", () => {
    expect(() =>
      loadConfig({ ...base, PK_USER_AGENT_CONTACT: exampleValue("PK_USER_AGENT_CONTACT") }),
    ).not.toThrow();
  });

  // A placeholder is spelled in capitals precisely so a human notices it, which
  // makes it the one thing we can detect mechanically. Real path segments here
  // are repository owners and names, which are not upper-case.
  test("ships no placeholder in the PluralKit contact URL", () => {
    const url = new URL(exampleValue("PK_USER_AGENT_CONTACT"));
    const placeholders = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0 && segment === segment.toUpperCase());
    expect(placeholders).toEqual([]);
    expect(url.pathname).not.toBe("/");
  });
});

describe("optional origins", () => {
  // A .env listing a key with nothing after it means "not set", not "set to an
  // empty string" — which would otherwise fail origin parsing at startup.
  test("an empty optional origin counts as absent", () => {
    expect(loadConfig({ ...base, PUBLIC_ASSET_ORIGIN: "" }).assetOrigin).toBe(base.PUBLIC_ORIGIN);
    expect(loadConfig({ ...base, PUBLIC_ASSET_ORIGIN: "   " }).assetOrigin).toBe(base.PUBLIC_ORIGIN);
  });

  test("a malformed optional origin is still rejected", () => {
    expect(() => loadConfig({ ...base, PUBLIC_ASSET_ORIGIN: "not-a-url" })).toThrow(ConfigError);
  });
});

describe("the API's network exposure", () => {
  /**
   * The API is internal: the browser never calls it and the web tier proxies
   * everything. Binding every interface would put the management API straight
   * on the network, reachable without going through the web tier at all — which
   * is what the architecture explicitly forbids.
   */
  test("binds loopback unless told otherwise", () => {
    expect(loadConfig(base).apiHost).toBe("127.0.0.1");
  });

  test("can be opened up deliberately, for containers", () => {
    expect(loadConfig({ ...base, API_HOST: "0.0.0.0" }).apiHost).toBe("0.0.0.0");
  });
});
