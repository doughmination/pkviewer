import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The content security policy is not covered by any request-level test, because
 * a policy that breaks the browser still returns 200 to a request that does not
 * execute JavaScript.
 *
 * A `script-src` without `'unsafe-eval'` blocked hydration in development while
 * every check still passed: pages rendered correctly, because they are
 * server-rendered, and nothing on them was interactive. Buttons did nothing and
 * no request ever reached the server.
 *
 * These assert the shape of the policy directly.
 */
const config = readFileSync(join(import.meta.dir, "..", "next.config.ts"), "utf8");

describe("content security policy", () => {
  // Next's development bundles evaluate modules through eval(); main-app.js
  // alone contains well over a hundred calls.
  test("development permits eval, which Next's dev bundles require", () => {
    expect(config).toContain("'unsafe-eval'");
  });

  test("development permits the hot-reload websocket", () => {
    expect(config).toContain("connect-src 'self' ws: wss:");
  });

  // Production bundles contain no eval, so the strict policy is safe there.
  test("production keeps the strict script and connect policy", () => {
    expect(config).toMatch(/isProduction[\s\S]{0,80}"script-src 'self' 'unsafe-inline'"/);
    expect(config).toMatch(/isProduction[\s\S]{0,80}"connect-src 'self'"/);
  });

  test("the relaxations are conditional, not unconditional", () => {
    expect(config).toContain("const scriptSrc = isProduction");
    expect(config).toContain("const connectSrc = isProduction");
  });

  // The directive that actually protects the management UI from clickjacking.
  test("framing is refused in every environment", () => {
    expect(config).toContain("frame-ancestors 'none'");
    expect(config).toContain('key: "X-Frame-Options", value: "DENY"');
  });

  test("the theme's style element and the font host stay allowed", () => {
    expect(config).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(config).toContain("font-src 'self' https://fonts.gstatic.com");
  });

  // Avatars and banners live wherever each system put them.
  test("images may come from any https host", () => {
    expect(config).toContain("img-src 'self' https: data:");
  });

  test("HSTS is production-only", () => {
    expect(config).toMatch(/isProduction[\s\S]{0,300}Strict-Transport-Security/);
  });
});
