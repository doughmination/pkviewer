import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CssIssue } from "@pkviewer/shared";
import { CssEditor } from "@/components/manage/CssEditor.tsx";
import { PageHeader } from "@/components/manage/Shell.tsx";
import { manageApi } from "@/lib/manage-api.ts";

export const metadata: Metadata = { title: "Advanced CSS" };

export default async function MemberCssPage({
  params,
}: {
  params: Promise<{ systemId: string; memberRef: string }>;
}) {
  const { systemId, memberRef } = await params;
  const result = await manageApi.get<{ source: string; issues: CssIssue[] }>(
    `/manage/systems/${systemId}/members/${encodeURIComponent(memberRef)}/css`,
  );
  if (!result.ok) notFound();

  return (
    <>
      <PageHeader
        title=""
        back={{
          href: `/manage/${systemId}/members/${encodeURIComponent(memberRef)}`,
          label: "Back to member",
        }}
      />
      <CssEditor
        systemId={systemId}
        memberRef={memberRef}
        initialSource={result.value.source}
        initialIssues={result.value.issues}
      />
    </>
  );
}
