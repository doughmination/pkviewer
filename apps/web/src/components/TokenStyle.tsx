/**
 * Emits sanitized `--pkv-*` custom properties.
 *
 * Deliberately knows NOTHING about the theme vocabulary. It receives a record
 * of names and values it does not interpret, so the vocabulary can change
 * without touching this file. Validation and the vocabulary itself live in
 * @pkviewer/shared/theme; this is the last line of defence, not the first.
 *
 * That defence still matters: themes are user-authored, so a value carrying
 * `;`, `}`, `url(` or a comment sequence could otherwise escape its
 * declaration and inject arbitrary CSS.
 */

const KEY_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Conservative by design: what colours, lengths and font stacks actually need.
 * Anything else is dropped rather than escaped, because a dropped token is a
 * visual bug and an escaped one is a security bug waiting to be got wrong. */
const VALUE_PATTERN = /^[a-zA-Z0-9\s.,%#()'"_-]+$/;
const FORBIDDEN = /url\(|@|\/\*|\*\/|<|>|;|\}|\{|expression|\\/i;

/** `var(--pkv-...)` is the one function form allowed, because the mapping layer
 * legitimately produces it and its shape is fully constrained. */
const ALLOWED_VAR = /^var\(--pkv-[a-z0-9-]+\)$/;

export function sanitizeCssVars(vars: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!KEY_PATTERN.test(key)) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 200) continue;
    if (ALLOWED_VAR.test(value)) {
      safe[key] = value;
      continue;
    }
    if (!VALUE_PATTERN.test(value)) continue;
    if (FORBIDDEN.test(value)) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Where the properties are declared.
 *
 * `:root` for a public page: the whole document belongs to that system, and
 * custom properties inherit downward only — declaring them on an inner element
 * means `body` never sees them, so the page background and base typography keep
 * the platform defaults while everything inside is themed.
 *
 * An element id for the editor's preview, which sits inside pkviewer's own UI
 * and must not leak its colours onto the surrounding page.
 */
export type TokenScope = ":root" | { elementId: string };

const ELEMENT_ID = /^[a-z][a-z0-9-]*$/;

function selectorFor(scope: TokenScope): string | null {
  if (scope === ":root") return ":root";
  return ELEMENT_ID.test(scope.elementId) ? `#${scope.elementId}` : null;
}

export function TokenStyle({
  vars,
  darkVars,
  scope,
  colorScheme,
}: {
  vars: Record<string, string>;
  /** Emitted under prefers-color-scheme: dark. Omitted when the theme commits
   * to a single ground. */
  darkVars?: Record<string, string>;
  scope: TokenScope;
  colorScheme?: "auto" | "light" | "dark";
}) {
  const selector = selectorFor(scope);
  if (!selector) return null;

  const light = sanitizeCssVars(vars);
  const dark = darkVars ? sanitizeCssVars(darkVars) : null;

  const declare = (entries: Record<string, string>) =>
    Object.entries(entries)
      .map(([key, value]) => `--pkv-${key}: ${value};`)
      .join(" ");

  if (Object.keys(light).length === 0) return null;

  const scheme =
    colorScheme === "light" ? "light" : colorScheme === "dark" ? "dark" : "light dark";

  let css = `${selector} { color-scheme: ${scheme}; ${declare(light)} }`;
  if (dark && Object.keys(dark).length > 0 && colorScheme === "auto") {
    css += ` @media (prefers-color-scheme: dark) { ${selector} { ${declare(dark)} } }`;
  }

  return <style>{css}</style>;
}
