import {
  COMPOSITION_MAP,
  FONTS,
  THEME_TOKEN_MAP,
  type CompositionDef,
  type TokenDef,
} from "./vocabulary.ts";

/**
 * Validation for stored theme and composition data.
 *
 * Nothing reaches the renderer without passing through here. A theme is
 * user-authored data, so this is a trust boundary: the point of the typed
 * vocabulary is that an arbitrary string can never become an arbitrary CSS
 * declaration.
 */

export type ValidationFailure =
  | "unknown_key"
  | "not_a_string"
  | "invalid_color"
  | "invalid_enum"
  | "unknown_font"
  | "invalid_length"
  | "invalid_boolean"
  | "not_member_overridable";

export type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; reason: ValidationFailure };

/**
 * Six-digit hex only.
 *
 * Not `rgb()`, not `color-mix()`, not named colours, and not three-digit hex:
 * one shape is trivial to validate, trivial to render in a colour picker, and
 * leaves no room for a function call to smuggle something through.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function validateAgainst(def: TokenDef | CompositionDef, raw: unknown): ValidationResult {
  if (typeof raw !== "string") return { ok: false, reason: "not_a_string" };
  const value = raw.trim();

  switch (def.type) {
    case "color":
      if (!HEX_COLOR.test(value)) return { ok: false, reason: "invalid_color" };
      return { ok: true, value: value.toUpperCase() };

    case "enum":
      if (!def.values.includes(value)) return { ok: false, reason: "invalid_enum" };
      return { ok: true, value };

    case "font":
      if (!Object.hasOwn(FONTS, value)) return { ok: false, reason: "unknown_font" };
      return { ok: true, value };

    case "length": {
      const match = value.match(/^(-?\d+(?:\.\d+)?)(px|rem)$/);
      if (!match || match[2] !== def.unit) return { ok: false, reason: "invalid_length" };
      const magnitude = Number(match[1]);
      if (!Number.isFinite(magnitude) || magnitude < def.min || magnitude > def.max) {
        return { ok: false, reason: "invalid_length" };
      }
      return { ok: true, value };
    }

    case "boolean":
      if (value !== "true" && value !== "false") return { ok: false, reason: "invalid_boolean" };
      return { ok: true, value };
  }
}

export function validateThemeToken(
  key: string,
  raw: unknown,
  opts: { level: "system" | "member" } = { level: "system" },
): ValidationResult {
  const def = THEME_TOKEN_MAP.get(key);
  if (!def) return { ok: false, reason: "unknown_key" };
  if (opts.level === "member" && !def.memberOverridable) {
    return { ok: false, reason: "not_member_overridable" };
  }
  return validateAgainst(def, raw);
}

export function validateCompositionValue(
  key: string,
  raw: unknown,
  opts: { level: "system" | "member" } = { level: "system" },
): ValidationResult {
  const def = COMPOSITION_MAP.get(key);
  if (!def) return { ok: false, reason: "unknown_key" };
  if (opts.level === "member" && !def.memberOverridable) {
    return { ok: false, reason: "not_member_overridable" };
  }
  return validateAgainst(def, raw);
}

export type SanitizedTheme = {
  /** Only keys that validated. */
  values: Record<string, string>;
  /** Keys explicitly reset to the platform default (stored as null). */
  resets: string[];
  /** Rejected keys, for reporting in an editor rather than silent loss. */
  rejected: Array<{ key: string; reason: ValidationFailure }>;
};

/**
 * Sanitizes a stored theme blob.
 *
 * Three states are preserved exactly as specified: a key that is absent
 * inherits, a key with a value overrides, and a key explicitly set to null
 * resets to the platform default rather than inheriting.
 *
 * Anything unrecognised or invalid is dropped and reported. Dropping is
 * deliberate: a theme stored before a vocabulary change must not break a page,
 * and a value we cannot validate must never be rendered.
 */
export function sanitizeTheme(
  raw: unknown,
  opts: { level: "system" | "member" },
): SanitizedTheme {
  const out: SanitizedTheme = { values: {}, resets: [], rejected: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) {
      // An explicit reset is only meaningful at member level, where there is
      // something to reset away from.
      const def = THEME_TOKEN_MAP.get(key);
      if (!def) {
        out.rejected.push({ key, reason: "unknown_key" });
        continue;
      }
      if (opts.level === "member" && !def.memberOverridable) {
        out.rejected.push({ key, reason: "not_member_overridable" });
        continue;
      }
      out.resets.push(key);
      continue;
    }

    const result = validateThemeToken(key, value, opts);
    if (result.ok) out.values[key] = result.value;
    else out.rejected.push({ key, reason: result.reason });
  }

  return out;
}

export function sanitizeComposition(
  raw: unknown,
  opts: { level: "system" | "member" },
): SanitizedTheme {
  const out: SanitizedTheme = { values: {}, resets: [], rejected: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) {
      const def = COMPOSITION_MAP.get(key);
      if (!def) {
        out.rejected.push({ key, reason: "unknown_key" });
        continue;
      }
      out.resets.push(key);
      continue;
    }
    const result = validateCompositionValue(key, value, opts);
    if (result.ok) out.values[key] = result.value;
    else out.rejected.push({ key, reason: result.reason });
  }

  return out;
}
