import { PageHeader, Section } from "@/components/manage/Shell.tsx";
import { manageApi } from "@/lib/manage-api.ts";

export const dynamic = "force-dynamic";

type AuditEvent = {
  at: number;
  accountId: string | null;
  action: string;
  target: string | null;
  detail: string | null;
};

/**
 * Who did what, and when.
 *
 * Reads the same `audit_events` table the rest of pkviewer writes to, filtered
 * to recognition actions. It is a record rather than a feature: granting a
 * badge changes somebody else's page, so there should never be a question about
 * where one came from.
 */
export default async function AdminAuditPage() {
  const result = await manageApi.get<{ events: AuditEvent[] }>("/admin/audit");

  return (
    <div className="mg-shell">
      <PageHeader title="History" description="Recent badge, credit and admin changes." />

      <Section>
        {!result.ok ? (
          <p className="mg-note" data-tone="error">Could not load the history.</p>
        ) : result.value.events.length === 0 ? (
          <p className="muted">Nothing has happened yet.</p>
        ) : (
          <ul className="mg-list">
            {result.value.events.map((event, i) => (
              <li key={`${event.at}-${i}`} className="mg-item">
                <div className="grow">
                  <code>{event.action}</code>
                  {event.target ? <span className="muted"> → {event.target}</span> : null}
                  <div className="mg-item-meta muted">
                    <span>{new Date(event.at).toLocaleString()}</span>
                    {event.detail ? <span>{event.detail}</span> : null}
                    <span>by {event.accountId ?? "a deleted account"}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
