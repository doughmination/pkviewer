import { SiteDisclosure } from "@/components/Notices.tsx";
import { webConfig } from "@/lib/config.ts";

/**
 * Rendered per request, not prerendered.
 *
 * This page embeds the configured public and app origins. Static prerendering
 * would bake the BUILD-TIME origin into the HTML, so moving from the beta host
 * to the production domain would need a rebuild rather than an env change —
 * which is exactly what decision 1 says must not be true. The cost is rendering
 * two tiny pages per request.
 */
export const dynamic = "force-dynamic";

/**
 * One 404 for everything.
 *
 * A system that does not exist, a member that does not exist, and a member
 * PluralKit keeps private all land here and read identically. Distinguishing
 * them would confirm that a private member exists (decision 5).
 */
export default function NotFound() {
  return (
    <main className="page stack">
      <h1>Not found</h1>
      <p className="prose">
        There is nothing at this address. The system or member may not exist, or
        may not be publicly listed.
      </p>
      <p>
        <a href={`${webConfig.publicOrigin}/`}>Back to pkviewer</a>
      </p>
      <SiteDisclosure beta={webConfig.beta} />
    </main>
  );
}
