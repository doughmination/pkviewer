import type { Metadata } from "next";
import { BoxArrowUpRight } from "react-bootstrap-icons";
import { SiteDisclosure } from "@/components/Notices.tsx";
import { getCredits } from "@/lib/api.ts";

/**
 * Who helped.
 *
 * Deliberately not a badge listing. A badge lives on someone's pkviewer page
 * and needs them to have one; a credit needs nothing but a name, so the person
 * who emailed a vulnerability report and never signed in still gets named.
 *
 * The sections are data, not markup: adding "Translators" is an admin action,
 * and this page has no list of categories in it to fall out of date.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Credits",
  description: "People who helped build pkviewer.",
};

export default async function CreditsPage() {
  const result = await getCredits();

  return (
    <main className="page stack">
      <header className="stack-tight">
        <h1>Credits</h1>
        <p className="prose">
          pkviewer exists because of people who reported things, broke things on
          purpose, and said when something was wrong.
        </p>
      </header>

      {!result.ok ? (
        <p className="prose muted">
          The credits could not be loaded right now. Please try again shortly.
        </p>
      ) : result.value.sections.length === 0 ? (
        <p className="prose muted">Nobody is credited yet.</p>
      ) : (
        result.value.sections.map((section) => (
          <section key={section.id} className="stack-tight">
            <h2>{section.label}</h2>
            {section.description ? <p className="muted">{section.description}</p> : null}
            <ul className="credit-list">
              {section.entries.map((entry) => (
                <li key={entry.id}>
                  <span className="credit-name">
                    {entry.url ? (
                      // Rendered as a link and never fetched, exactly like a
                      // social link. noopener because it is user-supplied.
                      <a href={entry.url} rel="noopener nofollow ugc" target="_blank">
                        {entry.name} <BoxArrowUpRight aria-hidden="true" />
                      </a>
                    ) : (
                      entry.name
                    )}
                  </span>
                  {entry.detail ? <span className="muted"> — {entry.detail}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <SiteDisclosure />
    </main>
  );
}
