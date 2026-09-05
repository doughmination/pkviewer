import { notFound } from "next/navigation";
import { manageApi, type SystemOverview } from "@/lib/manage-api.ts";
import { SystemNav } from "@/components/manage/SystemNav.tsx";

/**
 * The per-system shell.
 *
 * Loading the system here doubles as the authorization check: the API returns
 * 404 for any system this account does not manage, so an unauthorised id never
 * renders a shell at all.
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

  // Deliberately does NOT call notFound() here. Next renders the not-found
  // boundary for a layout without setting a 404 status, so the page looks right
  // and the response lies. Every page under this layout does its own check, so
  // the 404 comes from there with the correct status.
  if (!result.ok) return <>{children}</>;

  const system = result.value;

  return (
    <div className="mg-shell">
      <div className="mg-head">
        <h1>{system.name ?? system.pkSystemHid}</h1>
        <p>Editing how this system appears on the public site.</p>
      </div>
      <div className="mg-layout">
        <SystemNav systemId={systemId} />
        <div>{children}</div>
      </div>
    </div>
  );
}
