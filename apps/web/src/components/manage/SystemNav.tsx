"use client";

import { usePathname } from "next/navigation";
import { Globe2, Grid1x2, Link45deg, PaletteFill, People, Sliders } from "react-bootstrap-icons";

/**
 * Section navigation.
 *
 * A column on wide screens and a horizontal scroller on narrow ones. Shrinking
 * a sidebar until it is unusable is worse than changing its shape.
 */
const SECTIONS = [
  { slug: "", label: "Overview", Icon: Grid1x2 },
  { slug: "address", label: "Public address", Icon: Globe2 },
  { slug: "appearance", label: "Appearance", Icon: PaletteFill },
  { slug: "directory", label: "Layout", Icon: Sliders },
  { slug: "links", label: "Social links", Icon: Link45deg },
  { slug: "members", label: "Members", Icon: People },
];

export function SystemNav({ systemId }: { systemId: string }) {
  const pathname = usePathname();
  const base = `/manage/${systemId}`;

  return (
    <nav className="mg-nav" aria-label="System settings">
      {SECTIONS.map(({ slug, label, Icon }) => {
        const href = slug ? `${base}/${slug}` : base;
        const active = slug
          ? pathname.startsWith(href)
          : pathname === base || pathname === `${base}/`;
        return (
          <a key={label} href={href} aria-current={active ? "page" : undefined}>
            <Icon aria-hidden="true" />
            {label}
          </a>
        );
      })}
    </nav>
  );
}
