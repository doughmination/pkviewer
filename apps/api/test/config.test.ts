import { describe, expect, test } from "bun:test";
import { buildUserAgent, ConfigError, loadConfig } from "../src/config/index.ts";
import { PKVIEWER_VERSION } from "../src/config/version.ts";

const base = {
  NODE_ENV: "development",
  PUBLIC_APP_ORIGIN: "http://localhost:3000",
  PUBLIC_USERCONTENT_ORIGIN: "http://localhost:3002",
  PUBLIC_ASSET_ORIGIN: "http://localhost:3002",
  INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
  PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
};

describe("config", () => {
  test("parses a valid development environment", () => {
    const cfg = loadConfig(base);
    expect(cfg.appOrigin).toBe("http://localhost:3000");
    expect(cfg.beta.enabled).toBe(false);
    expect(cfg.pk.readRps).toBe(6);
  });

  test("normalises origins by stripping trailing slashes", () => {
    const cfg = loadConfig({ ...base, PUBLIC_APP_ORIGIN: "http://localhost:3000/" });
    expect(cfg.appOrigin).toBe("http://localhost:3000");
  });

  test("rejects an origin carrying a path", () => {
    expect(() => loadConfig({ ...base, PUBLIC_APP_ORIGIN: "http://localhost:3000/app" })).toThrow(
      ConfigError,
    );
  });

  // The user-content origin is the boundary keeping user-authored presentation
  // away from __Host- session cookies. Collapsing it into the app origin would
  // void that silently, so it must be fatal everywhere including development.
  test("refuses to boot when user content shares the app origin", () => {
    expect(() =>
      loadConfig({ ...base, PUBLIC_USERCONTENT_ORIGIN: "http://localhost:3000" }),
    ).toThrow(/must not equal PUBLIC_APP_ORIGIN/);
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
        PUBLIC_APP_ORIGIN: "https://app.example",
        PUBLIC_USERCONTENT_ORIGIN: "https://usercontent.example",
        PUBLIC_ASSET_ORIGIN: "https://usercontent.example",
        INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
        PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
        DISCORD_REDIRECT_URIS: "https://app.example/cb",
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
    const a = loadConfig({ ...base, PUBLIC_APP_ORIGIN: "https://beta.example" });
    const b = loadConfig({ ...base, PUBLIC_APP_ORIGIN: "https://production.example" });
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
    PUBLIC_APP_ORIGIN: "https://app.example",
    PUBLIC_USERCONTENT_ORIGIN: "https://public.example",
    PUBLIC_ASSET_ORIGIN: "https://public.example",
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

  test("production refuses to start without Discord credentials", () => {
    const { DISCORD_CLIENT_SECRET: _omitted, ...withoutDiscord } = prodBase;
    expect(() => loadConfig(withoutDiscord)).toThrow(/DISCORD_CLIENT/);
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
