import {
  ArrowRight,
  BoxArrowUpRight,
  ExclamationTriangle,
  PersonCircle,
  PlusLg,
} from "react-bootstrap-icons";
import { Note, PageHeader, Section } from "@/components/manage/Shell.tsx";
import { manageApi, type ManagedSystemSummary } from "@/lib/manage-api.ts";
import { webConfig } from "@/lib/config.ts";

/**
 * The dashboard.
 *
 * Lists only systems this account holds a grant for. The list comes from the
 * server already filtered — the client is never sent systems it may not manage
 * and asked to hide them.
 */
export default async function ManageDashboard() {
  const result = await manageApi.get<{ systems: ManagedSystemSummary[] }>("/manage/systems");

  if (!result.ok) {
    return (
      <div className="mg-shell">
        <PageHeader title="Your systems" />
        <Note icon={<ExclamationTriangle aria-hidden="true" />} tone="warn" role="alert">
          Your systems could not be loaded right now. Please refresh in a moment.
        </Note>
      </div>
    );
  }

  const systems = result.value.systems;
  if (systems.length === 0) return <EmptyState />;

  return (
    <div className="mg-shell">
      <PageHeader
        title="Your systems"
        description="Choose a system to edit how it appears on the web."
        actions={
          <a className="btn" href="/manage/claim">
            <PlusLg aria-hidden="true" /> Claim a system
          </a>
        }
      />

      <ul className="mg-list">
        {systems.map((system) => (
          <li key={system.systemId}>
            <a className="mg-item" href={`/manage/${system.systemId}`}>
              {system.avatarUrl ? (
                <img className="mg-thumb mg-thumb--round" src={system.avatarUrl} alt="" />
              ) : (
                <PersonCircle className="mg-thumb mg-thumb--round" aria-hidden="true" />
              )}

              <span className="mg-identity">
                <span className="name">{system.name ?? system.pkSystemHid}</span>
                <span className="meta">
                  <code>
                    {webConfig.publicOrigin.replace(/^https?:\/\//, "")}
                    {system.publicPath}
                  </code>
                  {system.memberCount !== null ? (
                    <span>
                      {system.memberCount} {system.memberCount === 1 ? "member" : "members"}
                    </span>
                  ) : null}
                </span>
              </span>

              {!system.reachable ? (
                <span className="mg-tag" data-tone="warn">PluralKit unreachable</span>
              ) : !system.slug ? (
                <span className="mg-tag">No address yet</span>
              ) : null}
              <ArrowRight aria-hidden="true" className="mg-chevron" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * No systems yet.
 *
 * Explains what claiming is for and offers the action, rather than describing a
 * process the reader then has to go and find.
 */
function EmptyState() {
  return (
    <div className="mg-shell mg-shell--narrow">
      <div className="mg-empty">
        <h1>No systems yet</h1>
        <p>
          pkviewer turns a PluralKit system into a website. PluralKit keeps the
          identity and the data; pkviewer decides how it looks on the web.
        </p>
        <p>To manage a system here, pkviewer needs to confirm you can act for it:</p>
        <ol>
          <li>
            <strong>Usually automatic.</strong> If the Discord account you signed
            in with is linked to a PluralKit system, pkviewer can confirm that on
            its own.
          </li>
          <li>
            <strong>Otherwise, a short code.</strong> pkviewer gives you a code to
            put in your system description for a moment, then checks for it.
          </li>
        </ol>
        <p>
          You never have to hand pkviewer a PluralKit token.
        </p>
        <div className="mg-actions">
          <a className="btn primary" href="/manage/claim">
            Claim a system <ArrowRight aria-hidden="true" />
          </a>
          <a className="btn quiet" href={webConfig.docsUrl} rel="noopener">
            Read about claiming <BoxArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
