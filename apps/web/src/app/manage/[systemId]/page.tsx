import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClockHistory, ExclamationTriangle, InfoCircle, PencilSquare } from "react-bootstrap-icons";
import { BadgeOffers } from "@/components/manage/BadgeOffers.tsx";
import { PublicUrl } from "@/components/manage/PublicUrl.tsx";
import { Note, PageHeader, Section } from "@/components/manage/Shell.tsx";
import { manageApi, type SystemOverview } from "@/lib/manage-api.ts";
import type { OfferedBadge } from "@pkviewer/shared";
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

  const offers = await manageApi.get<{ badges: OfferedBadge[] }>(
    `/manage/systems/${systemId}/badges`,
  );

  const publicUrl = `${webConfig.publicOrigin}${system.publicPath}`;
  const idUrl = `${webConfig.publicOrigin}/s/${system.pkSystemHid}`;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Where this system lives on the web, and what visitors see."
      />

      {!system.reachable ? (
        <Note icon={<ExclamationTriangle aria-hidden="true" />} tone="warn" role="status">
          PluralKit could not be reached, so some details may be out of date. Your
          settings are unaffected and still save normally.
        </Note>
      ) : null}

      <Section
        title="Public page"
        description="The link to share."
        actions={
          <a className="btn" href={`/manage/${systemId}/address`}>
            <PencilSquare aria-hidden="true" />
            {system.slug ? "Change address" : "Choose an address"}
          </a>
        }
      >
        {system.slug ? (
          <PublicUrl
            url={publicUrl}
            secondary={{
              url: idUrl,
              note: "Its PluralKit ID address also works and always will:",
            }}
          />
        ) : (
          <>
            <PublicUrl url={publicUrl} label="Current address" />
            <Note icon={<InfoCircle aria-hidden="true" />}>
              This system is public already. It has no chosen address yet, so it
              uses its PluralKit ID. Choosing one makes the link friendlier to
              share, and the ID address keeps working either way.
            </Note>
          </>
        )}
      </Section>

      <Section title="What visitors see" description="Taken from PluralKit's public information.">
        <dl className="mg-defs">
          <div className="mg-def">
            <dt>Name</dt>
            <dd>{system.name ?? "Not set"}</dd>
          </div>
          <div className="mg-def">
            <dt>Members listed</dt>
            <dd>
              {system.memberCount === null
                ? "Unknown"
                : `${system.memberCount} public ${system.memberCount === 1 ? "member" : "members"}`}
            </dd>
          </div>
          <div className="mg-def">
            <dt>Description</dt>
            <dd>
              {system.description
                ? `${system.description.slice(0, 160)}${system.description.length > 160 ? "…" : ""}`
                : "Not set"}
            </dd>
          </div>
        </dl>
      </Section>

      {offers.ok ? <BadgeOffers systemId={systemId} badges={offers.value.badges} /> : null}

      <Section
        title="Data freshness"
        description="pkviewer keeps a copy of PluralKit's public data so pages stay fast, and stay up if PluralKit is briefly unavailable."
      >
        <Note icon={<ClockHistory aria-hidden="true" />}>
          {system.snapshotAgeMs === null
            ? "No cached copy yet."
            : `Last refreshed ${formatAge(system.snapshotAgeMs)} ago.`}
        </Note>
      </Section>
    </>
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
