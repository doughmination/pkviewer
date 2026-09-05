import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveTheme, THEME_TOKENS } from "@pkviewer/shared";
import { ThemeEditor } from "@/components/manage/ThemeEditor.tsx";
import { manageApi, type SystemOverview } from "@/lib/manage-api.ts";
import { saveSystemTheme } from "../../actions.ts";

export const metadata: Metadata = { title: "Appearance" };

export default async function AppearancePage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;

  const [theme, overview] = await Promise.all([
    manageApi.get<{ tokens: Record<string, string | null> }>(`/manage/systems/${systemId}/theme`),
    manageApi.get<SystemOverview>(`/manage/systems/${systemId}`),
  ]);
  if (!theme.ok || !overview.ok) notFound();

  // At system level the layer beneath is the platform default, so that is what
  // "inherited" shows.
  const platform = resolveTheme({}, {}).light;
  const inherited: Record<string, string> = {};
  for (const def of THEME_TOKENS) inherited[def.key] = platform[def.key] ?? "";

  async function save(values: Record<string, string | null>) {
    "use server";
    return saveSystemTheme(systemId, values);
  }

  return (
    <>
      <p className="mg-note">
        These settings define the default appearance for this system and every
        member page under it. A member can override any of it on their own page.
      </p>
      <ThemeEditor
        level="system"
        initialValues={theme.value.tokens ?? {}}
        inheritedFrom={inherited}
        saveAction={save}
        previewName={overview.value.name ?? overview.value.pkSystemHid}
      />
    </>
  );
}
