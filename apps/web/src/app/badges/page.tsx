import type { Metadata } from "next";
import { BadgeSample } from "@/components/Badges.tsx";
import { SiteDisclosure } from "@/components/Notices.tsx";
import { getBadgeCatalogue } from "@/lib/api.ts";

/**
 * What the badges mean.
 *
 * This page is half the anti-forgery story. A badge on a system page links
 * here, and this page is served by pkviewer from a path nobody else controls —
 * so "Owner" typed into a system description has nowhere convincing to point,
 * and anyone unsure about a badge can check what it actually is.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Badges",
  description: "What the badges on a pkviewer page mean.",
};

export default async function BadgesPage() {
  const result = await getBadgeCatalogue();

  return (
    <main className="page stack">
      <header className="stack-tight">
        <h1>Badges</h1>
        <p className="prose">
          A badge is given by pkviewer, not set by the system it appears on. It
          shows only after the system has accepted it, and it can be handed back
          at any time.
        </p>
      </header>

      {!result.ok ? (
        <p className="prose muted">
          The badge list could not be loaded right now. Please try again shortly.
        </p>
      ) : (
        <ul className="badge-glossary">
          {result.value.badges.map((badge) => (
            <li key={badge.id}>
              <BadgeSample badge={badge} />
              <p className="muted">{badge.description}</p>
            </li>
          ))}
        </ul>
      )}

      <section className="prose stack-tight">
        <h2>Why they cannot be faked</h2>
        <p>
          Anything a system can write about itself — its name, its description,
          the label on a link — is ordinary text and is styled as ordinary text.
          A badge is not part of a page&apos;s appearance settings, so a system
          cannot restyle one, hide one, or make anything else look like one.
        </p>
        <p>
          If something looks like a badge but does not link here, it is not one.
        </p>
      </section>

      <SiteDisclosure />
    </main>
  );
}
