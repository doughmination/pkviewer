import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SocialLinksEditor } from "@/components/manage/SocialLinksEditor.tsx";
import { manageApi, type StoredSocial } from "@/lib/manage-api.ts";
import { saveSystemSocials } from "../../actions.ts";

export const metadata: Metadata = { title: "Social links" };

export default async function LinksPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;
  const stored = await manageApi.get<{ links: StoredSocial[] }>(
    `/manage/systems/${systemId}/socials`,
  );
  if (!stored.ok) notFound();

  async function save(links: Array<{ platform: string; label: string; url: string }>) {
    "use server";
    return saveSystemSocials(systemId, links);
  }

  return (
    <SocialLinksEditor
      ownerLabel="your system page"
      initialLinks={stored.value.links.map((l) => ({
        platform: l.platform,
        label: l.label ?? "",
        url: l.url,
      }))}
      saveAction={save}
    />
  );
}
