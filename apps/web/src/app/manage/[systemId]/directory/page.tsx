import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveComposition } from "@pkviewer/shared";
import { CompositionEditor } from "@/components/manage/CompositionEditor.tsx";
import { manageApi } from "@/lib/manage-api.ts";
import { saveSystemComposition } from "../../actions.ts";

export const metadata: Metadata = { title: "Layout" };

/**
 * Composition settings.
 *
 * Kept in its own section rather than mixed into Appearance, because it answers
 * a different question: what is on the page and how it is arranged, rather than
 * how it looks.
 */
export default async function DirectoryPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;
  const stored = await manageApi.get<{ composition: Record<string, string> }>(
    `/manage/systems/${systemId}/theme`,
  );
  if (!stored.ok) notFound();

  const resolved = resolveComposition(stored.value.composition ?? {}, {});

  async function save(values: Record<string, string>) {
    "use server";
    return saveSystemComposition(systemId, values);
  }

  return (
    <>
      <p className="mg-note">
        These control what appears on your pages and how it is arranged. They are
        separate from Appearance, which controls how things look.
      </p>
      <CompositionEditor initialValues={resolved} saveAction={save} />
    </>
  );
}
