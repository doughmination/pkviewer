/**
 * Slug normalisation and validation.
 *
 * A PluralKit ID is immutable external identity. A pkviewer slug is a mutable,
 * human-readable navigation label. They are never interchangeable: grants,
 * cache keys, foreign keys and reservations are all keyed on PluralKit's UUID,
 * never on a slug and never on a HID.
 *
 * Slugs are restricted to [a-z0-9-] (decision 4). That eliminates homograph
 * squatting outright rather than mitigating it — no Cyrillic "а" masquerading
 * as Latin "a" — and widening the set would require a confusable folding pass
 * rather than a change here.
 */

export type SlugScope = "system" | "member";

/**
 * Maximum length is deliberately below 36, the length of a UUID.
 *
 * That single constraint guarantees a UUID can never be mistaken for a slug, so
 * `/s/<uuid>` is always an unambiguous route to a system regardless of what
 * slugs anyone claims. It is the escape hatch that makes slug-first resolution
 * safe.
 */
export const SLUG_MAX_LENGTH = 32;

/** Systems live in one global namespace, where short names are contested, so
 * they carry a higher floor than members, who are namespaced per system. */
export const SYSTEM_SLUG_MIN_LENGTH = 3;
export const MEMBER_SLUG_MIN_LENGTH = 2;

/**
 * Reserved at the system level.
 *
 * `/s/` already namespaces system slugs away from application routes, so this
 * is mostly future-proofing: it keeps the door open to per-system subdomains or
 * bare-path URLs without having to claw names back from people who hold them.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "about", "abuse", "account", "accounts", "admin", "administrator", "api",
  "app", "assets", "auth", "billing", "blog", "cdn", "contact", "dashboard",
  "dev", "docs", "documentation", "edit", "email", "faq", "favicon", "help",
  "home", "id", "ids", "images", "img", "legal", "login", "logout", "mail",
  "manage", "me", "media", "member", "members", "my", "new", "news", "null",
  "pk", "pkviewer", "privacy", "public", "robots", "root", "s", "search",
  "security", "settings", "signin", "signout", "signup", "sitemap", "static",
  "status", "support", "system", "systems", "terms", "undefined", "user",
  "users", "www",
]);

export type SlugRejection =
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "edge_hyphen"
  | "double_hyphen"
  | "reserved"
  | "id_shaped";

export type SlugValidation =
  | { ok: true; normalized: string; display: string }
  | { ok: false; reason: SlugRejection };

/**
 * Casefolds and normalises a candidate slug.
 *
 * NFKC runs first so visually identical inputs collapse before validation; any
 * character that survives outside [a-z0-9-] is then rejected rather than
 * silently transliterated. Silently rewriting someone's input into a different
 * slug than they typed is worse than telling them it is not allowed.
 *
 * SQLite's COLLATE NOCASE is ASCII-only and cannot be trusted for uniqueness,
 * so normalisation happens here and `slug_normalized` is the unique column.
 */
export function normalizeSlug(input: string): string {
  return input.normalize("NFKC").trim().toLowerCase();
}

export function validateSlug(input: string, scope: SlugScope): SlugValidation {
  const normalized = normalizeSlug(input);

  if (normalized.length === 0) return { ok: false, reason: "empty" };

  const min = scope === "system" ? SYSTEM_SLUG_MIN_LENGTH : MEMBER_SLUG_MIN_LENGTH;
  if (normalized.length < min) return { ok: false, reason: "too_short" };
  if (normalized.length > SLUG_MAX_LENGTH) return { ok: false, reason: "too_long" };

  if (!/^[a-z0-9-]+$/.test(normalized)) return { ok: false, reason: "invalid_characters" };
  if (normalized.startsWith("-") || normalized.endsWith("-")) {
    return { ok: false, reason: "edge_hyphen" };
  }
  // Invariant L1b: a slug must not contain "--" ANYWHERE. Stated as the literal
  // substring rather than "no consecutive hyphens" so every validator enforces
  // exactly the same rule. The purpose is to keep the punycode marker "xn--"
  // unclaimable, so slugs stay safe to place in a hostname if per-system
  // subdomains ever happen.
  if (normalized.includes("--")) return { ok: false, reason: "double_hyphen" };

  // Reserved names apply to the global system namespace. Member slugs live
  // under their system, so they cannot collide with application routes.
  if (scope === "system" && RESERVED_SLUGS.has(normalized)) {
    return { ok: false, reason: "reserved" };
  }

  // A system slug may not take the shape of a PluralKit short id.
  //
  // System slugs and system ids share ONE global namespace at /s/<ref>, so a
  // slug shaped like an id could shadow the id URL of somebody else's system —
  // cross-tenant hijacking of a URL its owner never gave up. Removing the shape
  // from the namespace removes the ambiguity entirely, with no lookup needed.
  //
  // Member slugs are deliberately NOT restricted this way: they are namespaced
  // per system, so a collision can only ever shadow another member of the same
  // system, which the claimant already controls. That is self-inflicted rather
  // than an attack, so it is warned about at claim time instead of forbidden —
  // which keeps ordinary names like "clove" available where people want them.
  if (scope === "system" && looksLikeHid(normalized)) {
    return { ok: false, reason: "id_shaped" };
  }

  return { ok: true, normalized, display: normalized };
}

/**
 * True for a Discord snowflake.
 *
 * PluralKit will happily resolve a linked Discord account id to its system, and
 * that is exactly what tier-1 claiming relies on. It must NOT be reachable as a
 * public pkviewer URL, though: `/s/<snowflake>` would turn the Discord-account
 * to system mapping into something anyone can browse by guessing ids. Tier-1
 * verification uses this lookup with ids taken from the session; public
 * resolution refuses it.
 */
export function looksLikeSnowflake(ref: string): boolean {
  return /^\d{16,20}$/.test(ref);
}

/** True for a PluralKit UUID. Always unambiguous — a UUID is longer than any
 * slug may be, so it can never be shadowed. */
export function looksLikeUuid(ref: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
}

/**
 * True for the shape of a PluralKit short id: 5 or 6 lowercase letters.
 *
 * Used to keep the shape out of the SYSTEM slug namespace, and to decide
 * whether a reference is worth trying as an id at all. Member slugs are not
 * restricted by it.
 *
 * This encodes an assumption about PluralKit's id format: 5 or 6 lowercase
 * letters. If PluralKit ever issues ids containing digits, system slugs claimed
 * before that change could shadow one. The UUID form of every URL stays
 * unambiguous regardless, because a UUID is longer than any slug may be.
 */
export function looksLikeHid(ref: string): boolean {
  return /^[a-z]{5,6}$/.test(ref);
}

export const SLUG_REJECTION_MESSAGES: Readonly<Record<SlugRejection, string>> = {
  empty: "Enter a slug.",
  too_short: "That is too short.",
  too_long: `Use ${SLUG_MAX_LENGTH} characters or fewer.`,
  invalid_characters: "Use lowercase letters, numbers and hyphens only.",
  edge_hyphen: "Slugs cannot start or end with a hyphen.",
  double_hyphen: "Slugs cannot contain two hyphens in a row.",
  reserved: "That name is reserved.",
  id_shaped:
    "System slugs cannot be 5 or 6 letters with no numbers or hyphens, because " +
    "that is the shape of a PluralKit system ID. Add a number or a hyphen.",
};
