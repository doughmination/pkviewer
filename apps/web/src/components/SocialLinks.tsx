import type { SocialLink } from "@pkviewer/shared";
import { BoxArrowUpRight, Discord, Github, Globe, Mastodon, Twitch, Youtube } from "react-bootstrap-icons";

/**
 * Social links are rendered as links and never fetched server-side — no preview
 * cards, no favicon lookups. Fetching a user-supplied URL from our server is an
 * SSRF vector, and the guardrails rule it out.
 *
 * Icons come from the Bootstrap Icons set rather than bespoke SVGs (U1), with a
 * generic fallback for platforms the set does not cover.
 */

const ICONS: Record<string, typeof Globe> = {
  discord: Discord,
  github: Github,
  mastodon: Mastodon,
  twitch: Twitch,
  youtube: Youtube,
  website: Globe,
};

export function SocialLinks({ links }: { links: SocialLink[] }) {
  if (links.length === 0) return null;

  return (
    <ul className="socials">
      {links.map((link) => {
        const Icon = ICONS[link.platform.toLowerCase()] ?? BoxArrowUpRight;
        return (
          <li key={`${link.platform}-${link.url}`}>
            <a href={link.url} rel="nofollow noopener ugc" target="_blank">
              <Icon aria-hidden="true" />
              {link.label ?? link.platform}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
