import { describe, expect, test } from "bun:test";
import { TokenStyle, sanitizeCssVars } from "../src/components/TokenStyle.tsx";

/**
 * TokenStyle is the last line of defence, not the first. The vocabulary and its
 * validation already reject invalid data; these tests prove that even if
 * something bypassed all of that, nothing can escape a CSS declaration.
 */
describe("TokenStyle sanitisation", () => {
  test("passes through legitimate values", () => {
    const out = sanitizeCssVars({
      "color-page": "#FAF8FB",
      "font-body": 'system-ui, -apple-system, "Segoe UI", sans-serif',
      radius: "10px",
      density: "1.3",
    });
    expect(Object.keys(out)).toHaveLength(4);
  });

  test("allows the constrained var() form the mapping layer produces", () => {
    expect(sanitizeCssVars({ "avatar-radius": "var(--pkv-radius)" })).toEqual({
      "avatar-radius": "var(--pkv-radius)",
    });
  });

  test("rejects declaration escapes", () => {
    const out = sanitizeCssVars({
      a: "#fff; } body { display: none } .x {",
      b: "red; background: url(https://evil.test/x)",
      c: "}</style><script>alert(1)</script>",
    });
    expect(out).toEqual({});
  });

  test("rejects url(), at-rules and comments", () => {
    for (const value of [
      "url(https://evil.test/pixel.png)",
      "@import url(x)",
      "red /* comment */",
      "expression(alert(1))",
      "var(--x); color: red",
      "\\75 rl(x)",
    ]) {
      expect(sanitizeCssVars({ k: value })).toEqual({});
    }
  });

  test("rejects malformed property names", () => {
    for (const key of ["Color-Page", "color_page", "--evil", "a}b", "color-page;x"]) {
      expect(sanitizeCssVars({ [key]: "#FFFFFF" })).toEqual({});
    }
  });

  test("rejects absurdly long values", () => {
    expect(sanitizeCssVars({ k: "a".repeat(201) })).toEqual({});
  });
});

describe("where theme properties are declared", () => {
  /**
   * Custom properties inherit downward only. Declaring a public page's theme on
   * an inner element meant `body` never saw it: the page background and base
   * typography kept the platform defaults while everything inside the element
   * was themed. A preset looked like it "only applied to the members".
   */
  test("a public page declares its theme at the document root", () => {
    const rendered = renderTokenStyle({ scope: ":root", vars: { "color-page": "#FDF6F8" } });
    expect(rendered).toContain(":root {");
    expect(rendered).not.toContain("#:root");
    expect(rendered).toContain("--pkv-color-page: #FDF6F8;");
  });

  // The editor's preview sits inside pkviewer's own UI and must not repaint it.
  test("a scoped preview declares its theme on its own element only", () => {
    const rendered = renderTokenStyle({
      scope: { elementId: "pkv-preview" },
      vars: { "color-page": "#FDF6F8" },
    });
    expect(rendered).toContain("#pkv-preview {");
    expect(rendered).not.toContain(":root {");
  });

  test("dark values are emitted against the same selector", () => {
    const rendered = renderTokenStyle({
      scope: ":root",
      vars: { "color-page": "#FFFFFF" },
      darkVars: { "color-page": "#151219" },
      colorScheme: "auto",
    });
    expect(rendered).toContain("@media (prefers-color-scheme: dark) { :root {");
  });

  test("a malformed element id produces nothing rather than broken CSS", () => {
    expect(
      renderTokenStyle({ scope: { elementId: "evil } body { display:none" }, vars: { a: "1px" } }),
    ).toBe("");
  });
});

/** Renders TokenStyle to the CSS text it would emit. */
function renderTokenStyle(props: {
  scope: ":root" | { elementId: string };
  vars: Record<string, string>;
  darkVars?: Record<string, string>;
  colorScheme?: "auto" | "light" | "dark";
}): string {
  const element = TokenStyle(props as never) as { props?: { children?: string } } | null;
  return element?.props?.children ?? "";
}
