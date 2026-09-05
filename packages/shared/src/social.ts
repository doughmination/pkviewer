/**
 * Social link platforms.
 *
 * A fixed list plus a "custom" escape hatch. The platform is a label and an
 * icon choice — it never causes pkviewer to contact the linked service.
 *
 * Links are rendered as links and nothing more: no server-side fetching, no
 * preview cards, no favicon lookups. Fetching a user-supplied URL from our
 * server is an SSRF vector, and the guardrails rule it out entirely.
 */

export type SocialPlatformId =
  | "website"
  | "discord"
  | "github"
  | "mastodon"
  | "bluesky"
  | "tumblr"
  | "twitch"
  | "youtube"
  | "custom";

export type SocialPlatform = {
  id: SocialPlatformId;
  label: string;
  /** Placeholder shown in the editor. Illustrative only, never fetched. */
  placeholder: string;
};

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  { id: "website", label: "Website", placeholder: "https://example.com" },
  { id: "discord", label: "Discord", placeholder: "https://discord.gg/..." },
  { id: "github", label: "GitHub", placeholder: "https://github.com/..." },
  { id: "mastodon", label: "Mastodon", placeholder: "https://mastodon.social/@..." },
  { id: "bluesky", label: "Bluesky", placeholder: "https://bsky.app/profile/..." },
  { id: "tumblr", label: "Tumblr", placeholder: "https://example.tumblr.com" },
  { id: "twitch", label: "Twitch", placeholder: "https://twitch.tv/..." },
  { id: "youtube", label: "YouTube", placeholder: "https://youtube.com/@..." },
  { id: "custom", label: "Other", placeholder: "https://..." },
];

export const SOCIAL_PLATFORM_IDS: readonly string[] = SOCIAL_PLATFORMS.map((p) => p.id);

export const MAX_SOCIAL_LINKS = 12;
export const MAX_SOCIAL_URL_LENGTH = 500;
export const MAX_SOCIAL_LABEL_LENGTH = 60;

export type SocialUrlFailure = "empty" | "too_long" | "not_a_url" | "unsupported_scheme";

/**
 * Validates a social URL.
 *
 * Only http and https. `javascript:` and `data:` are the reason this exists —
 * a link rendered into an href is an XSS vector if any scheme is permitted.
 */
export function validateSocialUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: SocialUrlFailure } {
  if (typeof raw !== "string") return { ok: false, reason: "not_a_url" };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_SOCIAL_URL_LENGTH) return { ok: false, reason: "too_long" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme" };
  }
  return { ok: true, url: url.toString() };
}

export const SOCIAL_URL_MESSAGES: Readonly<Record<SocialUrlFailure, string>> = {
  empty: "Enter a link.",
  too_long: "That link is too long.",
  not_a_url: "That does not look like a web address.",
  unsupported_scheme: "Links must start with http:// or https://",
};
