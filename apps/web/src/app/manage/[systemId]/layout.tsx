import { manageApi, type SystemOverview } from "@/lib/manage-api.ts";
import { SystemNav } from "@/components/manage/SystemNav.tsx";

/**
 * The per-system shell.
 *
 * Loading the system here doubles as the authorization check, and gives every
 * section the same frame: the system's name once at the top, section navigation
 * beside it, and one content column.
 *
 * It deliberately does NOT call notFound(): Next renders the not-found boundary
 * for a layout without setting a 404 status. Every page below does its own
 * check, so the 404 comes from there with the correct status.
 */
export default async function SystemLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;
  const result = await manageApi.get<SystemOverview>(`/manage/systems/${systemId}`);
  if (!result.ok) return <>{children}</>;

  const system = result.value;

  return (
    <div className="mg-shell">
      <a className="mg-back" href="/manage">
        Your systems
      </a>
      <div className="mg-syshead">
        <h1>{system.name ?? system.pkSystemHid}</h1>
        <p>Editing how this system appears on the web.</p>
      </div>
      <div className="mg-layout">
        <SystemNav systemId={systemId} />
        <div className="mg-column">{children}</div>
      </div>
    </div>
  );
}
