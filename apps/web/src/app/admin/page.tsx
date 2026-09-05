import { Award, JournalText, People } from "react-bootstrap-icons";
import { PageHeader, Section } from "@/components/manage/Shell.tsx";
import { manageApi } from "@/lib/manage-api.ts";

export const dynamic = "force-dynamic";

type Assignment = { state: string };

export default async function AdminHome() {
  const assignments = await manageApi.get<{ assignments: Assignment[] }>("/admin/assignments");
  const credits = await manageApi.get<{ credits: unknown[]; sections: unknown[] }>("/admin/credits");

  const counts = { pending: 0, accepted: 0, declined: 0, hidden: 0, revoked: 0 };
  if (assignments.ok) {
    for (const a of assignments.value.assignments) {
      if (a.state in counts) counts[a.state as keyof typeof counts] += 1;
    }
  }

  return (
    <div className="mg-shell">
      <PageHeader
        title="Administration"
        description="Recognition and the credits page. Nothing here reaches anyone's system settings."
      />

      {counts.pending > 0 ? (
        <p className="mg-note">
          {counts.pending} badge {counts.pending === 1 ? "offer is" : "offers are"} waiting
          on a reply. A badge shows publicly only once its system accepts it.
        </p>
      ) : null}

      <Section title="Badges" description="Grant, revoke, and edit the catalogue.">
        <ul className="mg-stats">
          <li><strong>{counts.accepted}</strong> showing</li>
          <li><strong>{counts.pending}</strong> pending</li>
          <li><strong>{counts.hidden}</strong> hidden by owner</li>
          <li><strong>{counts.declined}</strong> declined</li>
          <li><strong>{counts.revoked}</strong> revoked</li>
        </ul>
        <div className="mg-actions">
          <a className="btn primary" href="/admin/badges">
            <Award aria-hidden="true" /> Manage badges
          </a>
        </div>
      </Section>

      <Section
        title="Credits"
        description="Anyone can be credited — no pkviewer account or PluralKit system needed."
      >
        <p className="muted">
          {credits.ok
            ? `${credits.value.credits.length} entries across ${credits.value.sections.length} sections.`
            : "Could not load the credits."}
        </p>
        <div className="mg-actions">
          <a className="btn primary" href="/admin/credits">
            <People aria-hidden="true" /> Manage credits
          </a>
          <a className="btn" href="/admin/audit">
            <JournalText aria-hidden="true" /> History
          </a>
        </div>
      </Section>
    </div>
  );
}
