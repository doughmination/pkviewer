/**
 * Types shared between the API and the web tier.
 *
 * Nothing here may import from the API's database or PluralKit modules: the web
 * tier consumes these types and reaches the API over HTTP, never the database
 * directly. That rule is what keeps the two-process split from decaying into
 * two backends.
 */

/** A resolved public view of a system, as the web tier receives it. */
export type SystemView = {
  /** PluralKit HID, the stable identity in URLs. */
  hid: string;
  /** pkviewer slug, when one is claimed. Canonical for display. */
  slug: string | null;
  name: string | null;
  description: string | null;
  tag: string | null;
  pronouns: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  color: string | null;
  memberCount: number;
  claimed: boolean;
  /** Set when served from a snapshot older than the freshness window. */
  staleSinceMs: number | null;
};

export type MemberView = {
  hid: string;
  slug: string | null;
  systemHid: string;
  systemSlug: string | null;
  name: string | null;
  displayName: string | null;
  description: string | null;
  pronouns: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  color: string | null;
  birthday: string | null;
};

export type SocialLink = {
  platform: string;
  label: string | null;
  url: string;
};

/** Resolved theme tokens, flat and dotted, ready to become CSS custom properties. */
export type ResolvedTokens = Readonly<Record<string, string>>;

import type { PublicBadge } from "./recognition.ts";

export * from "./theme/index.ts";
export * from "./social.ts";
export * from "./recognition.ts";

export type PageModel = {
  system: SystemView;
  member: MemberView | null;
  members: MemberView[];
  socials: SocialLink[];
  tokens: ResolvedTokens;
  /**
   * Resolved composition: what appears on the page and how it is arranged.
   * Separate from tokens throughout, and never turned into CSS properties by
   * the renderer except for the two layout values that genuinely are lengths.
   */
  composition: Readonly<Record<string, string>>;
  /**
   * Platform-issued recognition, already filtered to accepted grants.
   *
   * Present on system pages only. A badge recognises the system; repeating it
   * on every member page would misattribute it.
   */
  badges: PublicBadge[];
};
