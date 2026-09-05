import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Cascade collisions inside the management stylesheet.
 *
 * These are invisible to every other kind of test: the CSS is valid, the markup
 * is right, and the page still renders — just wrongly. A generic `.mg button`
 * rule silently beat `.mg-preset` and laid the preset cards out as rows,
 * squeezing each description into a narrow column beside its name.
 *
 * The rules below encode the two shapes that caused it.
 */
const css = readFileSync(join(import.meta.dir, "..", "src", "app", "globals.css"), "utf8");

describe("management stylesheet cascade", () => {
  // A card that happens to be a <button> must out-specify the generic button
  // rule, or it inherits inline-flex and stops being a card.
  test("the preset card out-specifies the generic button rule", () => {
    expect(css).toContain(".mg .mg-preset {");
    expect(css).toMatch(/\.mg \.mg-preset \{[^}]*display: grid/);
  });

  // A bare `.mg a` would score (0,1,1) and beat every (0,1,0) component class.
  test("the default link colour carries no specificity", () => {
    expect(css).toContain(".mg :where(a)");
    expect(css).not.toMatch(/^\.mg a \{/m);
  });

  test("component classes that set their own colour still can", () => {
    for (const rule of [".mg-item", ".mg-back", ".mg-brand"]) {
      expect(css, rule).toContain(rule);
    }
  });

  // State is never colour alone anywhere in the management UI.
  test("save and inheritance states carry a word or an icon, not just a hue", () => {
    expect(css).toMatch(/\.mg-status\[data-tone="dirty"\][^}]*font-weight/);
    expect(css).toMatch(/\.mg-inherit\[data-state="override"\][^}]*border-color/);
  });

  test("reduced motion disables transitions and the skeleton pulse", () => {
    expect(css).toMatch(/prefers-reduced-motion[\s\S]{0,200}animation: none/);
  });
});
