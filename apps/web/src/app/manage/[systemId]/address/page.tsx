import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SlugEditor, type SlugStatus } from "@/components/manage/SlugEditor.tsx";
import { manageApi, type SystemOverview } from "@/lib/manage-api.ts";
import { webConfig } from "@/lib/config.ts";
import { checkSlug, claimSlugAction, releaseSlugAction } from "../../actions.ts";

export const metadata: Metadata = { title: "Public address" };

/**
 * System address management.
 *
 * The address is a product feature, not an implementation detail: this page is
 * where a manager sees the URL people will share, and changes it.
 */
export default async function AddressPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;

  const [overview, status] = await Promise.all([
    manageApi.get<SystemOverview>(`/manage/systems/${systemId}`),
    manageApi.get<SlugStatus>(
      `/manage/slugs/status?scope=system&subjectId=${encodeURIComponent(systemId)}`,
    ),
  ]);
  if (!overview.ok || !status.ok) notFound();

  async function check(slug: string) {
    "use server";
    return checkSlug("system", systemId, systemId, slug);
  }
  async function claim(slug: string) {
    "use server";
    return claimSlugAction("system", systemId, slug);
  }
  async function release() {
    "use server";
    return releaseSlugAction("system", systemId);
  }

  return (
    <SlugEditor
      scope="system"
      status={status.value}
      actions={{ check, claim, release }}
      publicOrigin={webConfig.publicOrigin}
      basePath="/s"
      idPath={`/s/${overview.value.pkSystemHid}`}
      idLabel="PluralKit ID"
    />
  );
}
