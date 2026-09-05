import { BoxArrowUpRight, ClockHistory, InfoCircle } from "react-bootstrap-icons";
import { webConfig } from "@/lib/config.ts";

/**
 * The third-party disclosure.
 *
 * One notice, on every public page: pkviewer is not PluralKit. This disclosure
 * is permanent — it is what keeps a third-party site from reading as an
 * official one.
 */
export function SiteDisclosure() {
  return (
    <footer className="site-footer muted">
      <p className="prose">
        <InfoCircle aria-hidden="true" /> Presented by pkviewer, a third-party
        website for PluralKit systems. pkviewer is not PluralKit, and system and
        member information shown here comes from PluralKit&apos;s public API.
      </p>
      <p className="site-footer-links">
        <a href="/credits">Credits</a>
        <a href="/badges">Badges</a>
        {webConfig.docsUrl ? (
          <a href={webConfig.docsUrl} rel="noopener">
            Documentation <BoxArrowUpRight aria-hidden="true" />
          </a>
        ) : null}
      </p>
    </footer>
  );
}

/**
 * Shown when PluralKit was unreachable and the page rendered from the last good
 * snapshot (P3). The page is informative rather than broken: the content is
 * real, just possibly behind.
 */
export function StaleNotice({ staleSinceMs }: { staleSinceMs: number }) {
  return (
    <p className="notice muted" role="status">
      <ClockHistory aria-hidden="true" />
      <span>
        PluralKit could not be reached, so this page is showing information
        saved {formatAge(staleSinceMs)} ago. It may be out of date.
      </span>
    </p>
  );
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
