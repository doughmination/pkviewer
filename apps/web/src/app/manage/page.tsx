import { ArrowRight, BoxArrowUpRight, ExclamationTriangle, PersonCircle } from "react-bootstrap-icons";
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
  const systems = result.ok ? result.value.systems : [];

  return (
    <div className="mg-shell">
      {!result.ok ? (
        <p className="mg-note" data-tone="warn" role="alert">
          <ExclamationTriangle aria-hidden="true" />
          Could not load your systems right now. Please refresh in a moment.
        </p>
      ) : systems.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="mg-head">
            <h1>Your systems</h1>
            <p>Choose a system to edit how it appears on the web.</p>
          </div>
          <ul className="mg-list">
            {systems.map((system) => (
              <li key={system.systemId}>
                <a className="mg-card" href={`/manage/${system.systemId}`}>
                  {system.avatarUrl ? (
                    <img className="mg-thumb" src={system.avatarUrl} alt="" />
                  ) : (
                    <PersonCircle className="mg-thumb" aria-hidden="true" />
                  )}
                  <span className="grow">
                    <span className="title">{system.name ?? system.pkSystemHid}</span>
                    <span className="sub">
                      {webConfig.publicOrigin.replace(/^https?:\/\//, "")}
                      {system.publicPath}
                      {system.memberCount !== null ? ` · ${system.memberCount} members` : ""}
                    </span>
                  </span>
                  {!system.reachable ? (
                    <span className="mg-tag" data-tone="warn">PluralKit unreachable</span>
                  ) : system.slug ? (
                    <span className="mg-tag" data-tone="ok">{system.slug}</span>
                  ) : (
                    <span className="mg-tag">No address yet</span>
                  )}
                </a>
              </li>
            ))}
          </ul>
          <p style={{ marginTop: 18 }}>
            <a className="btn" href="/manage/claim">
              Claim another system <ArrowRight aria-hidden="true" />
            </a>
          </p>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mg-shell mg-empty">
      <h1>No systems yet</h1>
      <p>
        pkviewer turns a PluralKit system into a website. PluralKit keeps the
        identity and the data; pkviewer decides how it looks on the web.
      </p>
      <p>To manage a system here, pkviewer needs to confirm you can act for it:</p>
      <ol>
        <li>
          <strong>Usually automatic.</strong> If the Discord account you signed in
          with is linked to a PluralKit system, pkviewer can confirm that on its
          own.
        </li>
        <li>
          <strong>Otherwise, a short code.</strong> pkviewer gives you a code to
          put in your system description for a moment, then checks for it.
        </li>
      </ol>
      <p>
        You never have to hand pkviewer a PluralKit token. Claiming is limited
        while pkviewer is in beta.
      </p>
      <p>
        <a className="btn" href="/manage/claim" style={{ fontWeight: 600 }}>
          Claim a system <ArrowRight aria-hidden="true" />
        </a>
      </p>
      {webConfig.docsUrl ? (
        <p>
          <a className="btn" href={webConfig.docsUrl} rel="noopener">
            Read about claiming <BoxArrowUpRight aria-hidden="true" />
          </a>
        </p>
      ) : null}
    </div>
  );
}
