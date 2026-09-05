import { sanitizeComposition, sanitizeTheme } from "./validate.ts";
import {
  COMPOSITION,
  FONTS,
  THEME_TOKENS,
  type FontEntry,
  type FontId,
  type TokenDef,
} from "./vocabulary.ts";

/**
 * Inheritance and CSS mapping.
 *
 *   platform default  ->  system theme  ->  member override
 *
 *   key absent   inherit
 *   key = value  override
 *   key = null   reset to the platform default, ignoring the system
 *
 * The three-state model lives here and nowhere else.
 */

export type Scheme = "light" | "dark";

export type ResolvedTheme = {
  /** Every declared token, with a value, for each scheme. */
  light: Record<string, string>;
  dark: Record<string, string>;
  /** What the system chose: follow the device, or commit to one ground. */
  scheme: "auto" | "light" | "dark";
  /** Families the page must load, derived from the resolved fonts. */
  fonts: FontEntry[];
};

export type ResolvedComposition = Record<string, string>;

function defaultFor(def: TokenDef, scheme: Scheme): string {
  switch (def.type) {
    case "color":
      return def.default[scheme];
    case "boolean":
      return def.default ? "true" : "false";
    default:
      return def.default;
  }
}

/**
 * Resolves theme layers into complete per-scheme value maps.
 *
 * Both a light and a dark map always come back. When the scheme is `auto` the
 * renderer emits both and lets `prefers-color-scheme` choose; when it is
 * committed, only one is used. Custom colours apply to whichever ground is
 * active — the vocabulary does not double in size to carry two of every colour,
 * which would be the wrong trade for a non-technical editor.
 */
export function resolveTheme(
  systemRaw: unknown,
  memberRaw: unknown = null,
): ResolvedTheme {
  const system = sanitizeTheme(systemRaw, { level: "system" });
  const member = sanitizeTheme(memberRaw, { level: "member" });

  const build = (scheme: Scheme): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const def of THEME_TOKENS) {
      const platform = defaultFor(def, scheme);

      // A member reset ignores the system layer entirely and lands on the
      // platform default. That is the whole point of the third state: escaping
      // a loud system theme should not require restating every default.
      if (member.resets.includes(def.key)) {
        out[def.key] = platform;
        continue;
      }

      const memberValue = member.values[def.key];
      if (memberValue !== undefined && def.memberOverridable) {
        out[def.key] = memberValue;
        continue;
      }

      out[def.key] = system.values[def.key] ?? platform;
    }
    return out;
  };

  const light = build("light");
  const dark = build("dark");

  const schemeValue = (light["color.scheme"] ?? "auto") as "auto" | "light" | "dark";

  const fontIds = new Set<FontId>();
  for (const key of ["font.body", "font.heading"]) {
    const id = light[key] as FontId | undefined;
    if (id && Object.hasOwn(FONTS, id)) fontIds.add(id);
  }

  return {
    light,
    dark,
    scheme: schemeValue,
    fonts: [...fontIds].map((id) => FONTS[id]).filter((f) => f.family !== null),
  };
}

export function resolveComposition(
  systemRaw: unknown,
  memberRaw: unknown = null,
): ResolvedComposition {
  const system = sanitizeComposition(systemRaw, { level: "system" });
  const member = sanitizeComposition(memberRaw, { level: "member" });

  const out: ResolvedComposition = {};
  for (const def of COMPOSITION) {
    const platform = def.type === "boolean" ? (def.default ? "true" : "false") : def.default;

    if (member.resets.includes(def.key)) {
      out[def.key] = platform;
      continue;
    }
    const memberValue = member.values[def.key];
    if (memberValue !== undefined && def.memberOverridable) {
      out[def.key] = memberValue;
      continue;
    }
    out[def.key] = system.values[def.key] ?? platform;
  }
  return out;
}

// -------------------------------------------------------------- CSS mapping

/**
 * Named options become concrete CSS here, and only here.
 *
 * This indirection is what keeps the vocabulary from being "CSS variables with
 * a UI": a user picks `relaxed`, not `1.35`. The scale can be retuned later
 * without invalidating a single stored theme.
 */
const RADIUS: Record<string, string> = {
  none: "0px",
  small: "4px",
  medium: "10px",
  large: "18px",
};

const FONT_SIZE: Record<string, string> = {
  small: "15px",
  medium: "16.5px",
  large: "18.5px",
};

const DENSITY: Record<string, string> = {
  compact: "0.8",
  normal: "1",
  relaxed: "1.3",
};

const AVATAR_RADIUS: Record<string, string> = {
  circle: "50%",
  rounded: "var(--pkv-radius)",
  square: "0px",
};

/** Card treatment expands into the three properties it actually controls. */
function surfaceProperties(style: string): Record<string, string> {
  switch (style) {
    case "filled":
      return {
        "surface-bg": "var(--pkv-color-surface)",
        "surface-border": "transparent",
        "surface-pad": "1",
      };
    case "plain":
      return {
        "surface-bg": "transparent",
        "surface-border": "transparent",
        "surface-pad": "0",
      };
    default:
      return {
        "surface-bg": "var(--pkv-color-surface)",
        "surface-border": "var(--pkv-color-border)",
        "surface-pad": "1",
      };
  }
}

/**
 * Maps resolved tokens to the `--pkv-*` custom properties the stylesheet reads.
 *
 * Returned as a plain record so `TokenStyle` stays entirely opaque: it receives
 * names and values it does not interpret, exactly as it did before this
 * vocabulary existed.
 */
export function themeToCssVars(resolved: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {};

  const put = (name: string, value: string | undefined) => {
    if (value !== undefined) vars[name] = value;
  };

  put("color-page", resolved["color.page"]);
  put("color-surface", resolved["color.surface"]);
  put("color-text", resolved["color.text"]);
  put("color-muted", resolved["color.muted"]);
  put("color-accent", resolved["color.accent"]);
  put("color-border", resolved["color.border"]);

  const bodyId = (resolved["font.body"] ?? "system") as FontId;
  const headingId = (resolved["font.heading"] ?? "system") as FontId;
  put("font-body", FONTS[bodyId]?.stack);
  put("font-heading", FONTS[headingId]?.stack);
  put("font-size", FONT_SIZE[resolved["font.size"] ?? "medium"]);

  put("radius", RADIUS[resolved["shape.radius"] ?? "medium"]);
  put("density", DENSITY[resolved["density"] ?? "normal"]);
  put("avatar-radius", AVATAR_RADIUS[resolved["avatar.shape"] ?? "rounded"]);

  for (const [name, value] of Object.entries(
    surfaceProperties(resolved["surface.style"] ?? "outlined"),
  )) {
    vars[name] = value;
  }

  return vars;
}

/** Composition values the stylesheet needs as custom properties. Kept minimal:
 * composition is mostly consumed as data by components, not as CSS. */
export function compositionToCssVars(resolved: ResolvedComposition): Record<string, string> {
  const columns: Record<string, string> = {
    auto: "repeat(auto-fill, minmax(min(100%, 15rem), 1fr))",
    one: "1fr",
    two: "repeat(auto-fill, minmax(min(100%, 45%), 1fr))",
    three: "repeat(auto-fill, minmax(min(100%, 30%), 1fr))",
  };
  const avatarSize: Record<string, string> = {
    small: "56px",
    medium: "88px",
    large: "128px",
  };
  return {
    "directory-columns": columns[resolved["directory.columns"] ?? "auto"] ?? columns["auto"]!,
    "avatar-size": avatarSize[resolved["avatar.size"] ?? "medium"] ?? avatarSize["medium"]!,
  };
}
