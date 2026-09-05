import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClockHistory, ExclamationTriangle, InfoCircle } from "react-bootstrap-icons";
import { PublicUrl } from "@/components/manage/PublicUrl.tsx";
import { manageApi, type SystemOverview } from "@/lib/manage-api.ts";
import { webConfig } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;
  const result = await manageApi.get<SystemOverview>(`/manage/systems/${systemId}`);
  if (!result.ok) notFound();
  const system = result.value;

  const publicUrl = `${webConfig.publicOrigin}${system.publicPath}`;

  return (
    <>
      {!system.reachable ? (
        <p className="mg-note" data-tone="warn" role="status">
          <ExclamationTriangle aria-hidden="true" />
          PluralKit could not be reached, so some details may be out of date.
          Your settings are unaffected and still save normally.
        </p>
      ) : null}

      <section className="mg-panel">
        <h2>Public page</h2>
        <p className="hint">Where this system appears on the web.</p>

        {system.slug ? (
          <PublicUrl
            url={publicUrl}
            secondary={{
              url: `${webConfig.publicOrigin}/s/${system.pkSystemHid}`,
              note: "Its PluralKit ID address also works and always will:",
            }}
          />
        ) : (
          <>
            <PublicUrl url={publicUrl} label="Current address" />
            <p className="mg-note">
              <InfoCircle aria-hidden="true" />
              <span>
                This system is public already. It has no chosen address yet, so
                it uses its PluralKit ID. Choosing one makes the link friendlier
                to share, and the ID address keeps working either way.
              </span>
            </p>
          </>
        )}

        <p style={{ marginBottom: 0 }}>
          <a className="btn" href={`/manage/${systemId}/address`}>
            {system.slug ? "Change public address" : "Choose an address"}
          </a>
        </p>
      </section>

      <section className="mg-panel">
        <h2>What visitors see</h2>
        <p className="hint">Taken from PluralKit&apos;s public information.</p>
        <dl style={{ margin: 0, display: "grid", gap: 10 }}>
          <Row label="Name" value={system.name ?? "Not set"} />
          <Row
            label="Members listed"
            value={
              system.memberCount === null
                ? "Unknown"
                : `${system.memberCount} public ${system.memberCount === 1 ? "member" : "members"}`
            }
          />
          <Row
            label="Description"
            value={system.description ? `${system.description.slice(0, 120)}${system.description.length > 120 ? "…" : ""}` : "Not set"}
          />
        </dl>
      </section>

      <section className="mg-panel">
        <h2>Data freshness</h2>
        <p className="hint">
          pkviewer caches PluralKit&apos;s public data so pages stay fast and
          stay up if PluralKit is briefly unavailable.
        </p>
        <p className="mg-note">
          <ClockHistory aria-hidden="true" />
          <span>
            {system.snapshotAgeMs === null
              ? "No cached copy yet."
              : `Last refreshed ${formatAge(system.snapshotAgeMs)} ago.`}
          </span>
        </p>
      </section>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 160px) 1fr", gap: 12 }}>
      <dt className="desc" style={{ margin: 0 }}>{label}</dt>
      <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
    </div>
  );
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}
