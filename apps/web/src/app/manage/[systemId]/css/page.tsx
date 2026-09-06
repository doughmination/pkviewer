import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CssIssue } from "@pkviewer/shared";
import { CssEditor } from "@/components/manage/CssEditor.tsx";
import { manageApi } from "@/lib/manage-api.ts";

export const metadata: Metadata = { title: "Advanced CSS" };

export default async function CssPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;
  const result = await manageApi.get<{ source: string; issues: CssIssue[] }>(
    `/manage/systems/${systemId}/css`,
  );
  if (!result.ok) notFound();

  return (
    <CssEditor
      systemId={systemId}
      initialSource={result.value.source}
      initialIssues={result.value.issues}
    />
  );
}
