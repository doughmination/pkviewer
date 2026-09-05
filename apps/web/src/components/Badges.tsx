import {
  Bug,
  Code,
  Gem,
  HeartFill,
  PatchCheckFill,
  PeopleFill,
  ShieldFill,
  StarFill,
} from "react-bootstrap-icons";
import type { BadgeIconId, PublicBadge } from "@pkviewer/shared";

/**
 * Platform-issued recognition on a public page.
 *
 * These are the one element of a public page a system does not control, and
 * that is the entire point: a badge is only worth having if it cannot be
 * reproduced by putting "Owner" in a system description or a social link label.
 *
 * Two rules make that hold, and both are enforced elsewhere by tests:
 *
 *   1. Nothing here reads a `--pkv-*` custom property. The theme vocabulary
 *      emits those, so a badge that used them could be restyled — or hidden —
 *      by the system it is meant to describe. Badge styling is `--pkvb-*`,
 *      which no theme token can name.
 *   2. Icon and tone come from a fixed vocabulary, never from a stored string.
 *      An unknown icon renders as the neutral fallback rather than nothing, so
 *      a catalogue change cannot silently blank a badge.
 *
 * Every badge links to /badges, which is platform-owned. Imitation text has
 * nowhere convincing to point.
 */

const ICONS: Record<BadgeIconId, React.ComponentType<{ "aria-hidden"?: boolean | "true" }>> = {
  star: StarFill,
  heart: HeartFill,
  people: PeopleFill,
  bug: Bug,
  shield: ShieldFill,
  code: Code,
  patch: PatchCheckFill,
  gem: Gem,
};

export function BadgeRow({ badges }: { badges: PublicBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <ul className="pkvb-row" aria-label="pkviewer recognition">
      {badges.map((badge) => {
        const Icon = ICONS[badge.icon] ?? PatchCheckFill;
        return (
          <li key={badge.id}>
            <a
              className="pkvb"
              data-tone={badge.tone}
              href="/badges"
              title={badge.description}
            >
              <Icon aria-hidden="true" />
              <span>{badge.label}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** The same badge, shown large on the glossary page. */
export function BadgeSample({ badge }: { badge: PublicBadge }) {
  const Icon = ICONS[badge.icon] ?? PatchCheckFill;
  return (
    <span className="pkvb" data-tone={badge.tone}>
      <Icon aria-hidden="true" />
      <span>{badge.label}</span>
    </span>
  );
}
