import { ArrowRight, BoxArrowUpRight } from "react-bootstrap-icons";
import { SiteDisclosure } from "@/components/Notices.tsx";
import { webConfig } from "@/lib/config.ts";

/**
 * Rendered per request, not prerendered.
 *
 * This page embeds the configured public and app origins. Static prerendering
 * would bake the BUILD-TIME origin into the HTML, so moving to another host
 * to the production domain would need a rebuild rather than an env change —
 * which is exactly what decision 1 says must not be true. The cost is rendering
 * two tiny pages per request.
 */
export const dynamic = "force-dynamic";

/**
 * The public landing page.
 *
 * Permanently logged out (O3). The __Host- session cookie is pinned to the app
 * host and physically cannot reach this origin, so this page can never show
 * "signed in as", "your systems", or any account state. The sign-in link is
 * unconditional, and points at the app origin.
 *
 * Copy here is placeholder structure. The real wording is a product decision.
 */
export default function LandingPage() {
  return (
    <main className="page stack">
      <header className="stack-tight">
        <h1>pkviewer</h1>
        <p className="prose">
          PluralKit handles the identity and the data. pkviewer handles how that
          identity is presented on the web.
        </p>
      </header>

      <section className="stack-tight prose">
        <h2>What it does</h2>
        <p>
          Every PluralKit system gets a public page, and every member can have
          one too. Systems that sign in can choose a readable address and
          customise how their pages look.
        </p>
        <p className="muted">
          Viewing is open to everyone. An account is only needed to manage and
          customise a system.
        </p>
      </section>

      <section className="stack-tight prose">
        <h2>Addresses</h2>
        <p>
          A system is always reachable by its PluralKit ID, and additionally by
          its chosen name once it has one. Both work; the readable one is
          canonical.
        </p>
        <ul className="meta-list" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <li><code>/s/abcdef</code> <span className="muted">— PluralKit ID, always works</span></li>
          <li><code>/s/your-system</code> <span className="muted">— chosen address</span></li>
          <li><code>/s/your-system/a-member</code> <span className="muted">— a member</span></li>
        </ul>
      </section>

      <p>
        <a href="/login">
          Sign in with Discord <ArrowRight aria-hidden="true" />
        </a>
      </p>
      <p>
        <a href={webConfig.docsUrl} rel="noopener">
          Read the documentation <BoxArrowUpRight aria-hidden="true" />
        </a>
      </p>

      <SiteDisclosure />
    </main>
  );
}
