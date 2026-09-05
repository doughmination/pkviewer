import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BADGE_ICON_IDS, BADGE_TONE_IDS } from "@pkviewer/shared";

/**
 * Badges must not be reachable from a system's own theme.
 *
 * This is the property the whole feature rests on. A pkviewer badge is worth
 * something because the system it describes cannot produce one — and cannot
 * alter one. Themes emit `--pkv-*` custom properties, so a badge rule that read
 * any of them would hand that control straight back: recolour a badge to
 * impersonate a different one, or set it to the page background to hide it.
 *
 * A stylesheet like this is exactly where that regresses silently. The CSS
 * stays valid, the page still renders, and the only symptom is that a badge
 * quietly obeys the page it is supposed to be independent of.
 */

const root = join(import.meta.dir, "..", "src");
const css = readFileSync(join(root, "app", "globals.css"), "utf8");
const component = readFileSync(join(root, "components", "Badges.tsx"), "utf8");

/**
 * Every rule whose selector targets a badge.
 *
 * Selected by selector rather than by position in the file: a boundary based on
 * where the section happens to sit would silently start covering whatever rule
 * gets added after it, which is how the first version of this test managed to
 * fail on an unrelated `.member-card` rule.
 */
function badgeRules(): { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
    .filter((rule) => /(^|[\s,>])\.?a?\.pkvb\b/.test(rule.selector) || rule.selector.includes(".pkvb"));
}

describe("badge styling is out of a theme's reach", () => {
  test("no badge rule reads a theme property", () => {
    const rules = badgeRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      // `--pkv-` is the theme vocabulary's prefix. `--pkvb-` is the badge's
      // own, which no theme token can name — so the check has to tell the two
      // apart rather than matching the shorter prefix.
      const themeReads = [...rule.body.matchAll(/--pkv-[a-z-]+/g)].map((m) => m[0]);
      expect(themeReads, rule.selector).toEqual([]);
    }
  });

  test("badges declare their own typography rather than inheriting it", () => {
    const base = badgeRules().find((r) => r.selector === ".pkvb");
    expect(base).toBeDefined();
    // A theme sets the page typeface. Inheriting it would let a system make a
    // badge look like its own text, or its text look like a badge.
    for (const property of ["font-family", "font-size", "font-weight", "border-radius"]) {
      expect(base!.body, property).toContain(`${property}:`);
    }
  });

  test("every tone in the vocabulary has a rule, and none has an extra", () => {
    const styled = badgeRules()
      .map((r) => r.selector.match(/\.pkvb\[data-tone="([a-z]+)"\]/)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(new Set(styled)).toEqual(new Set(BADGE_TONE_IDS));
  });

  test("every icon in the vocabulary maps to a component", () => {
    // A missing entry would fall through to the neutral fallback, which is a
    // quiet way for a badge to lose its identity.
    for (const icon of BADGE_ICON_IDS) {
      expect(component, icon).toMatch(new RegExp(`\\b${icon}:\\s*\\w`));
    }
  });

  test("a badge links to the platform glossary", () => {
    // Half the anti-forgery story: imitation text has nowhere to point.
    expect(component).toContain('href="/badges"');
  });

  test("the theme vocabulary cannot emit a badge property", async () => {
    const { THEME_TOKENS } = (await import("@pkviewer/shared")) as {
      THEME_TOKENS: readonly { cssVar?: string; id?: string }[];
    };
    for (const token of THEME_TOKENS ?? []) {
      const emitted = token.cssVar ?? "";
      expect(emitted.startsWith("--pkvb"), emitted).toBe(false);
    }
  });
});
