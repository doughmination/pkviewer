import { describe, expect, test } from "bun:test";
import {
  COMPOSITION,
  COMPOSITION_KEYS,
  FONTS,
  FONT_IDS,
  MEMBER_OVERRIDABLE_KEYS,
  PRESETS,
  THEME_TOKENS,
  THEME_TOKEN_KEYS,
  compositionToCssVars,
  resolveComposition,
  resolveTheme,
  sanitizeTheme,
  themeToCssVars,
  validateCompositionValue,
  validateThemeToken,
} from "../src/theme/index.ts";

const TYPES = ["color", "length", "enum", "font", "boolean"];

describe("vocabulary shape", () => {
  test("every token declares a supported type", () => {
    for (const def of THEME_TOKENS) {
      expect(TYPES).toContain(def.type);
    }
  });

  test("every token has a platform default", () => {
    for (const def of THEME_TOKENS) {
      if (def.type === "color") {
        expect(def.default.light).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(def.default.dark).toMatch(/^#[0-9A-Fa-f]{6}$/);
      } else if (def.type === "boolean") {
        expect(typeof def.default).toBe("boolean");
      } else {
        expect(def.default).toBeTruthy();
      }
    }
  });

  test("every default is itself a valid value", () => {
    for (const def of THEME_TOKENS) {
      const value =
        def.type === "color"
          ? def.default.light
          : def.type === "boolean"
            ? String(def.default)
            : def.default;
      expect(validateThemeToken(def.key, value).ok).toBe(true);
    }
  });

  test("enum defaults are members of their own value list", () => {
    for (const def of THEME_TOKENS) {
      if (def.type === "enum") expect(def.values).toContain(def.default);
    }
  });

  test("font defaults name a font in the allow-list", () => {
    for (const def of THEME_TOKENS) {
      if (def.type === "font") expect(FONT_IDS).toContain(def.default);
    }
  });

  test("keys are unique, flat and dotted", () => {
    expect(new Set(THEME_TOKEN_KEYS).size).toBe(THEME_TOKEN_KEYS.length);
    for (const key of THEME_TOKEN_KEYS) expect(key).toMatch(/^[a-z]+(\.[a-z]+)*$/);
  });

  // The vocabulary is a product surface, not a CSS dumping ground: it has to
  // stay small enough for a person to hold in their head.
  test("stays small enough to be understood at a glance", () => {
    expect(THEME_TOKENS.length).toBeLessThanOrEqual(20);
    expect(COMPOSITION.length).toBeLessThanOrEqual(12);
  });

  // Composition changes what appears and how it is arranged; theme changes how
  // it looks. Mixing them is what turns a design API into CSS-with-a-UI.
  test("theme and composition vocabularies do not overlap", () => {
    for (const key of COMPOSITION_KEYS) {
      expect(THEME_TOKEN_KEYS).not.toContain(key);
    }
  });

  test("every font entry has a usable stack", () => {
    for (const id of FONT_IDS) {
      const font = FONTS[id];
      expect(font.stack.length).toBeGreaterThan(0);
      expect(font.weights.length).toBeGreaterThan(0);
    }
  });
});

describe("validation", () => {
  test("enum tokens reject undeclared values", () => {
    expect(validateThemeToken("density", "spacious")).toEqual({
      ok: false,
      reason: "invalid_enum",
    });
    expect(validateThemeToken("density", "relaxed").ok).toBe(true);
  });

  test("font tokens reject fonts outside the allow-list", () => {
    expect(validateThemeToken("font.body", "Comic Sans MS")).toEqual({
      ok: false,
      reason: "unknown_font",
    });
    // No URLs, ever.
    expect(validateThemeToken("font.body", "https://evil.test/font.woff2")).toEqual({
      ok: false,
      reason: "unknown_font",
    });
    expect(validateThemeToken("font.body", "atkinson").ok).toBe(true);
  });

  test("colour tokens accept only six-digit hex", () => {
    expect(validateThemeToken("color.accent", "#A23B72").ok).toBe(true);
    for (const bad of ["#fff", "red", "rgb(1,2,3)", "var(--x)", "#GGGGGG", "#A23B72;"]) {
      expect(validateThemeToken("color.accent", bad).ok).toBe(false);
    }
  });

  test("colour values are normalised so equal colours compare equal", () => {
    const result = validateThemeToken("color.accent", "  #a23b72  ");
    expect(result).toEqual({ ok: true, value: "#A23B72" });
  });

  test("unknown keys are rejected", () => {
    expect(validateThemeToken("color.rainbow", "#FFFFFF")).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  test("non-string values are rejected", () => {
    expect(validateThemeToken("density", 3)).toEqual({ ok: false, reason: "not_a_string" });
    expect(validateThemeToken("density", { evil: true })).toEqual({
      ok: false,
      reason: "not_a_string",
    });
  });

  test("boolean composition values accept only true and false", () => {
    expect(validateCompositionValue("show.pronouns", "true").ok).toBe(true);
    expect(validateCompositionValue("show.pronouns", "yes")).toEqual({
      ok: false,
      reason: "invalid_boolean",
    });
  });

  // Member-level overrides are enforced at validation, not merely ignored at
  // render: an editor must be able to say why something was refused.
  test("member-only enforcement rejects system-only tokens", () => {
    expect(validateThemeToken("color.scheme", "dark", { level: "member" })).toEqual({
      ok: false,
      reason: "not_member_overridable",
    });
    expect(validateThemeToken("color.scheme", "dark", { level: "system" }).ok).toBe(true);
  });

  test("sanitize reports rejections instead of silently dropping them", () => {
    const result = sanitizeTheme(
      { "color.accent": "#A23B72", "color.rainbow": "#FFFFFF", density: "spacious" },
      { level: "system" },
    );
    expect(result.values).toEqual({ "color.accent": "#A23B72" });
    expect(result.rejected).toHaveLength(2);
  });

  test("sanitize survives junk input", () => {
    for (const junk of [null, undefined, "string", 42, [1, 2, 3]]) {
      expect(sanitizeTheme(junk, { level: "system" }).values).toEqual({});
    }
  });
});

describe("inheritance", () => {
  const system = { "color.accent": "#112233", density: "compact", "font.body": "nunito" };

  test("absent means inherit from the system", () => {
    const resolved = resolveTheme(system, {});
    expect(resolved.light["color.accent"]).toBe("#112233");
    expect(resolved.light["density"]).toBe("compact");
  });

  test("a value overrides the system", () => {
    const resolved = resolveTheme(system, { "color.accent": "#445566" });
    expect(resolved.light["color.accent"]).toBe("#445566");
  });

  // The third state is what lets a member escape a loud system theme without
  // restating every platform default by hand.
  test("explicit null resets to the platform default, not the system value", () => {
    const resolved = resolveTheme(system, { "color.accent": null, density: null });
    expect(resolved.light["color.accent"]).toBe("#A23B72");
    expect(resolved.light["density"]).toBe("normal");
  });

  test("unset tokens fall through to the platform default", () => {
    const resolved = resolveTheme({}, {});
    for (const key of THEME_TOKEN_KEYS) {
      expect(resolved.light[key]).toBeDefined();
      expect(resolved.dark[key]).toBeDefined();
    }
  });

  test("a member cannot override a system-only token", () => {
    const resolved = resolveTheme({ "color.scheme": "light" }, { "color.scheme": "dark" });
    expect(resolved.scheme).toBe("light");
  });

  test("member-overridable tokens are exactly those declared", () => {
    for (const def of THEME_TOKENS) {
      const attempt = resolveTheme({}, { [def.key]: sampleValueFor(def) });
      const applied = attempt.light[def.key] === sampleValueFor(def);
      expect(applied).toBe(def.memberOverridable);
    }
  });

  test("light and dark differ only in colour", () => {
    const resolved = resolveTheme({}, {});
    for (const def of THEME_TOKENS) {
      if (def.type === "color") {
        expect(resolved.light[def.key]).not.toBe(resolved.dark[def.key]);
      } else {
        expect(resolved.light[def.key]).toBe(resolved.dark[def.key]);
      }
    }
  });

  test("composition resolves through the same three states", () => {
    const resolved = resolveComposition({ "avatar.size": "large" }, { "avatar.size": null });
    expect(resolved["avatar.size"]).toBe("medium");
    expect(resolveComposition({ "avatar.size": "large" }, {})["avatar.size"]).toBe("large");
    expect(
      resolveComposition({ "directory.columns": "two" }, { "directory.columns": "three" })[
        "directory.columns"
      ],
      // Not member-overridable: the system's directory layout wins.
    ).toBe("two");
  });
});

describe("presets", () => {
  test("there are between three and five", () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(PRESETS.length).toBeLessThanOrEqual(5);
  });

  test("every preset value is a valid declared token", () => {
    for (const preset of PRESETS) {
      for (const [key, value] of Object.entries(preset.tokens)) {
        const result = validateThemeToken(key, value);
        expect(result.ok, `${preset.id}.${key} = ${value}`).toBe(true);
      }
    }
  });

  test("presets carry an id, a name and a described character", () => {
    const ids = new Set<string>();
    for (const preset of PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.character.length).toBeGreaterThan(30);
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
    }
  });

  // Five colour swaps would not demonstrate the vocabulary's range.
  test("presets differ in more than colour", () => {
    const shape = (p: (typeof PRESETS)[number]) =>
      [p.tokens["font.body"], p.tokens["shape.radius"], p.tokens["surface.style"], p.tokens["density"]].join("|");
    expect(new Set(PRESETS.map(shape)).size).toBe(PRESETS.length);
  });

  test("presets cover both light and dark grounds", () => {
    const schemes = new Set(PRESETS.map((p) => p.tokens["color.scheme"]));
    expect(schemes.has("light") || schemes.has("auto")).toBe(true);
    expect(schemes.has("dark")).toBe(true);
  });
});

describe("css mapping", () => {
  test("maps every resolved theme to concrete CSS values", () => {
    const vars = themeToCssVars(resolveTheme({}, {}).light);
    for (const name of ["color-page", "color-text", "font-body", "radius", "density"]) {
      expect(vars[name]).toBeDefined();
    }
  });

  // Named options exist so the scale can be retuned without invalidating stored
  // themes: the user picked "relaxed", not a number.
  test("named options become values, not raw user input", () => {
    const compact = themeToCssVars(resolveTheme({ density: "compact" }, {}).light);
    const relaxed = themeToCssVars(resolveTheme({ density: "relaxed" }, {}).light);
    expect(compact["density"]).not.toBe(relaxed["density"]);
    expect(Number(relaxed["density"])).toBeGreaterThan(Number(compact["density"]));
  });

  test("font tokens map to allow-listed stacks only", () => {
    const vars = themeToCssVars(resolveTheme({ "font.body": "jetbrains-mono" }, {}).light);
    expect(vars["font-body"]).toContain("JetBrains Mono");
  });

  test("composition maps to layout values", () => {
    const vars = compositionToCssVars(resolveComposition({ "directory.columns": "one" }, {}));
    expect(vars["directory-columns"]).toBe("1fr");
  });

  // Invalid data must never reach the renderer, even if it somehow reached
  // storage: resolution drops it and the platform default stands.
  test("invalid stored data cannot produce a CSS value", () => {
    const hostile = {
      "color.page": "#fff; } body { display:none } .x {",
      "font.body": "url(https://evil.test/x.woff2)",
      density: "9999",
      "color.accent": "expression(alert(1))",
    };
    const resolved = resolveTheme(hostile, {});
    const vars = themeToCssVars(resolved.light);
    const dump = JSON.stringify(vars);

    expect(dump).not.toContain("display:none");
    expect(dump).not.toContain("evil.test");
    expect(dump).not.toContain("expression");
    expect(vars["color-page"]).toBe("#FAF8FB");
    expect(vars["density"]).toBe("1");
  });

  test("resolved values only ever contain safe characters", () => {
    const vars = themeToCssVars(resolveTheme({}, {}).light);
    for (const value of Object.values(vars)) {
      expect(value).not.toMatch(/[;{}<>]/);
    }
  });
});

function sampleValueFor(def: (typeof THEME_TOKENS)[number]): string {
  switch (def.type) {
    case "color":
      return "#123456";
    case "enum":
      return def.values.find((v) => v !== def.default) ?? def.default;
    case "font":
      return def.default === "system" ? "nunito" : "system";
    case "boolean":
      return def.default ? "false" : "true";
    case "length":
      return def.default;
  }
}

describe("member overridability declaration", () => {
  test("the exported list matches the declarations", () => {
    const declared = THEME_TOKENS.filter((t) => t.memberOverridable).map((t) => t.key);
    expect([...MEMBER_OVERRIDABLE_KEYS].sort()).toEqual(declared.sort());
  });
});
