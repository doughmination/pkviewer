import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * pkviewer is not in beta any more, and this makes sure it stays that way.
 *
 * Removing a feature flag usually leaves debris: an unused env var in an
 * example file, a message nobody can trigger, a config key still read by one
 * caller. That debris is worse than the flag was, because it looks like a
 * working gate. This walks the tree and asserts the whole vocabulary is gone.
 */

const root = join(import.meta.dir, "..", "..", "..");

const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  ".next-prod",
  "dist",
  "coverage",
  // This file names the terms it forbids.
  "no-beta.test.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css|sql|json|yml|yaml)$/.test(entry) || entry === ".env.example") {
      out.push(full);
    }
  }
  return out;
}

/** The identifiers that made up the beta gate. */
const FORBIDDEN = [
  "BETA_MODE",
  "BETA_ALLOWED_DISCORD_IDS",
  "beta_not_allowed",
  "betaNoIndex",
  "canClaim",
  "cfg.beta",
  "webConfig.beta",
];

describe("beta is gone, not disabled", () => {
  const files = walk(root);

  test("the tree is scanned at all", () => {
    // A broken walk would make every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(40);
  });

  for (const term of FORBIDDEN) {
    test(`no file mentions ${term}`, () => {
      const offenders = files.filter((f) => readFileSync(f, "utf8").includes(term));
      expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
    });
  }

  // The allow-list is the one that mattered: while it existed, claiming was
  // closed to everyone not on it, and an empty list denied everybody.
  test("claiming is not gated by any allow-list", () => {
    const claims = readFileSync(join(root, "apps/api/src/http/routes/claims.ts"), "utf8");
    expect(claims).not.toMatch(/allow.?list/i);
    // Claiming now refuses only the unauthenticated. `not_owner` on unclaim is
    // still a legitimate 403, so this checks the gate rather than the status.
    expect(claims).not.toMatch(/requireClaimant[\s\S]{0,400}?403/);
  });

  // Public pages were noindex throughout the beta. They should be indexable
  // now, while the management and admin planes stay out of search results.
  test("public pages are indexable and the control planes are not", () => {
    const layout = readFileSync(join(root, "apps/web/src/app/layout.tsx"), "utf8");
    expect(layout).not.toContain("robots");

    for (const shell of ["manage", "admin"]) {
      const text = readFileSync(join(root, `apps/web/src/app/${shell}/layout.tsx`), "utf8");
      expect(text, shell).toContain("robots: { index: false, follow: false }");
    }
  });
});
